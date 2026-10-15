import { rendererInvoke } from '@common/rendererIpc'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'

export const getRadioConversation = (revision: number) => rendererInvoke<any, any>(WIN_MAIN_RENDERER_EVENT_NAME.radio_host_chat_state, { revision })
export const sendRadioMessage = (message: { id: string, text: string, kind: string, song?: Record<string, string> }) => rendererInvoke<any, any>(WIN_MAIN_RENDERER_EVENT_NAME.radio_host_chat_send, message)
export const cancelRadioMessage = (id: string) => rendererInvoke<any, any>(WIN_MAIN_RENDERER_EVENT_NAME.radio_host_chat_cancel, { id })
