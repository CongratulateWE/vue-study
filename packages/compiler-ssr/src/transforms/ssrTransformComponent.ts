import {
  NodeTransform,
  NodeTypes,
  ElementTypes,
  createCallExpression,
  resolveComponentType,
  buildProps,
  ComponentNode,
  SlotFnBuilder,
  createFunctionExpression,
  buildSlots,
  FunctionExpression,
  TemplateChildNode,
  PORTAL,
  SUSPENSE,
  TRANSITION_GROUP,
  createIfStatement,
  createSimpleExpression,
  getDOMTransformPreset,
  createReturnStatement,
  ReturnStatement,
  Namespaces,
  locStub,
  RootNode,
  TransformContext,
  CompilerOptions,
  TransformOptions,
  createRoot,
  createTransformContext,
  traverseNode,
  ExpressionNode,
  TemplateNode
} from '@vue/compiler-dom'
import { SSR_RENDER_COMPONENT } from '../runtimeHelpers'
import {
  SSRTransformContext,
  processChildren,
  processChildrenAsStatement
} from '../ssrCodegenTransform'
import { isSymbol, isObject, isArray } from '@vue/shared'

// We need to construct the slot functions in the 1st pass to ensure proper
// scope tracking, but the children of each slot cannot be processed until
// the 2nd pass, so we store the WIP slot functions in a weakmap during the 1st
// pass and complete them in the 2nd pass.
const wipMap = new WeakMap<ComponentNode, WIPSlotEntry[]>()

interface WIPSlotEntry {
  fn: FunctionExpression
  children: TemplateChildNode[]
  vnodeBranch: ReturnStatement
}

const componentTypeMap = new WeakMap<ComponentNode, symbol>()

export const ssrTransformComponent: NodeTransform = (node, context) => {
  if (
    node.type !== NodeTypes.ELEMENT ||
    node.tagType !== ElementTypes.COMPONENT
  ) {
    return
  }

  const component = resolveComponentType(node, context, true /* ssr */)
  if (isSymbol(component)) {
    componentTypeMap.set(node, component)
    return // built-in component: fallthrough
  }

  // Build the fallback vnode-based branch for the component's slots.
  // We need to clone the node into a fresh copy and use the buildSlots' logic
  // to get access to the children of each slot. We then compile them with
  // a child transform pipeline using vnode-based transforms (instead of ssr-
  // based ones), and save the result branch (a ReturnStatement) in an array.
  // The branch is retrieved when processing slots again in ssr mode.
  const vnodeBranches: ReturnStatement[] = []
  const clonedNode = clone(node)

  return function ssrPostTransformComponent() {
    buildSlots(clonedNode, context, (props, children) => {
      vnodeBranches.push(createVNodeSlotBranch(props, children, context))
      return createFunctionExpression(undefined)
    })

    const props =
      node.props.length > 0
        ? // note we are not passing ssr: true here because for components, v-on
          // handlers should still be passed
          buildProps(node, context).props || `null`
        : `null`

    const wipEntries: WIPSlotEntry[] = []
    wipMap.set(node, wipEntries)

    const buildSSRSlotFn: SlotFnBuilder = (props, children, loc) => {
      const fn = createFunctionExpression(
        [props || `_`, `_push`, `_parent`, `_scopeId`],
        undefined, // no return, assign body later
        true, // newline
        true, // isSlot
        loc
      )
      wipEntries.push({
        fn,
        children,
        // build the children using normal vnode-based transforms
        // TODO fixme: `children` here has already been mutated at this point
        // so the sub-transform runs into errors :/
        vnodeBranch: vnodeBranches[wipEntries.length]
      })
      return fn
    }

    const slots = node.children.length
      ? buildSlots(node, context, buildSSRSlotFn).slots
      : `null`

    node.ssrCodegenNode = createCallExpression(
      context.helper(SSR_RENDER_COMPONENT),
      [component, props, slots, `_parent`]
    )
  }
}

export function ssrProcessComponent(
  node: ComponentNode,
  context: SSRTransformContext
) {
  if (!node.ssrCodegenNode) {
    // this is a built-in component that fell-through.
    // just render its children.
    const component = componentTypeMap.get(node)!

    if (component === PORTAL) {
      // TODO
      return
    }

    const needFragmentWrapper =
      component === SUSPENSE || component === TRANSITION_GROUP
    processChildren(node.children, context, needFragmentWrapper)
  } else {
    // finish up slot function expressions from the 1st pass.
    const wipEntries = wipMap.get(node) || []
    for (let i = 0; i < wipEntries.length; i++) {
      const { fn, children, vnodeBranch } = wipEntries[i]
      // For each slot, we generate two branches: one SSR-optimized branch and
      // one normal vnode-based branch. The branches are taken based on the
      // presence of the 2nd `_push` argument (which is only present if the slot
      // is called by `_ssrRenderSlot`.
      fn.body = createIfStatement(
        createSimpleExpression(`_push`, false),
        processChildrenAsStatement(
          children,
          context,
          false,
          true /* withSlotScopeId */
        ),
        vnodeBranch
      )
    }
    context.pushStatement(createCallExpression(`_push`, [node.ssrCodegenNode]))
  }
}

export const rawOptionsMap = new WeakMap<RootNode, CompilerOptions>()

const [vnodeNodeTransforms, vnodeDirectiveTransforms] = getDOMTransformPreset(
  true
)

function createVNodeSlotBranch(
  props: ExpressionNode | undefined,
  children: TemplateChildNode[],
  parentContext: TransformContext
): ReturnStatement {
  // apply a sub-transform using vnode-based transforms.
  const rawOptions = rawOptionsMap.get(parentContext.root)!
  const subOptions = {
    ...rawOptions,
    // overwrite with vnode-based transforms
    nodeTransforms: [
      ...vnodeNodeTransforms,
      ...(rawOptions.nodeTransforms || [])
    ],
    directiveTransforms: {
      ...vnodeDirectiveTransforms,
      ...(rawOptions.directiveTransforms || {})
    }
  }

  // wrap the children with a wrapper template for proper children treatment.
  const wrapperNode: TemplateNode = {
    type: NodeTypes.ELEMENT,
    ns: Namespaces.HTML,
    tag: 'template',
    tagType: ElementTypes.TEMPLATE,
    isSelfClosing: false,
    // important: provide v-slot="props" on the wrapper for proper
    // scope analysis
    props: [
      {
        type: NodeTypes.DIRECTIVE,
        name: 'slot',
        exp: props,
        arg: undefined,
        modifiers: [],
        loc: locStub
      }
    ],
    children,
    loc: locStub,
    codegenNode: undefined
  }
  subTransform(wrapperNode, subOptions, parentContext)
  return createReturnStatement(children)
}

function subTransform(
  node: TemplateChildNode,
  options: TransformOptions,
  parentContext: TransformContext
) {
  const childRoot = createRoot([node])
  const childContext = createTransformContext(childRoot, options)
  // inherit parent scope analysis state
  childContext.scopes = { ...parentContext.scopes }
  childContext.identifiers = { ...parentContext.identifiers }
  // traverse
  traverseNode(childRoot, childContext)
  // merge helpers/components/directives/imports into parent context
  ;(['helpers', 'components', 'directives', 'imports'] as const).forEach(
    key => {
      childContext[key].forEach((value: any) => {
        ;(parentContext[key] as any).add(value)
      })
    }
  )
}

function clone(v: any): any {
  if (isArray(v)) {
    return v.map(clone)
  } else if (isObject(v)) {
    const res: any = {}
    for (const key in v) {
      res[key] = clone(v[key])
    }
    return res
  } else {
    return v
  }
}