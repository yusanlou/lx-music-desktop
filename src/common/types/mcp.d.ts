declare namespace LX {
  namespace MCP {
    /** MCP 服务运行状态 */
    interface Status {
      status: boolean
      message: string
      address: string
    }

    /** 启用/停用 MCP 服务的参数 */
    interface EnableServer {
      enable: boolean
      port: string
      bindLan: boolean
    }

    interface ActionBase<A> {
      action: A
    }
    interface ActionData<A, D> extends ActionBase<A> {
      data: D
    }
    type Action<A, D = undefined> = D extends undefined ? ActionBase<A> : ActionData<A, D>

    type Actions = Action<'status'>
    | Action<'enable', EnableServer>

    /** 主进程 -> 渲染进程 的桥接调用载荷 */
    interface BridgeCall {
      requestId: string
      method: string
      params?: any
    }

    /** 渲染进程 -> 主进程 的桥接响应载荷 */
    interface BridgeResponse {
      requestId: string
      error?: string
      result?: any
    }
  }
}
