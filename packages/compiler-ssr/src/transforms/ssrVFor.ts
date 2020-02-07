import {
  createStructuralDirectiveTransform,
  ForNode,
  processFor,
  createCallExpression,
  createFunctionExpression,
  createForLoopParams,
  NodeTypes
} from '@vue/compiler-dom'
import {
  SSRTransformContext,
  processChildrenAsStatement
} from '../ssrCodegenTransform'
import { SSR_RENDER_LIST } from '../runtimeHelpers'

// Plugin for the first transform pass, which simply constructs the AST node
export const ssrTransformFor = createStructuralDirectiveTransform(
  'for',
  processFor
)

// This is called during the 2nd transform pass to construct the SSR-sepcific
// codegen nodes.
export function ssrProcessFor(node: ForNode, context: SSRTransformContext) {
  const needFragmentWrapper =
    node.children.length !== 1 || node.children[0].type !== NodeTypes.ELEMENT
  const renderLoop = createFunctionExpression(
    createForLoopParams(node.parseResult)
  )
  renderLoop.body = processChildrenAsStatement(
    node.children,
    context,
    needFragmentWrapper
  )

  // v-for always renders a fragment
  context.pushStringPart(`<!---->`)
  context.pushStatement(
    createCallExpression(context.helper(SSR_RENDER_LIST), [
      node.source,
      renderLoop
    ])
  )
  context.pushStringPart(`<!---->`)
}