import { rendererInvoke } from '@common/rendererIpc'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { radioPlayback } from './playback'

export const getHostSettings = async(): Promise<any> => {
  const result = await rendererInvoke<any>(WIN_MAIN_RENDERER_EVENT_NAME.radio_host_settings_get)
  if (result.ok) radioPlayback.updateSettings(result.values)
  return result
}
export const saveHostSettings = async(patch: Record<string, any>): Promise<any> => {
  const result = await rendererInvoke<Record<string, any>, any>(WIN_MAIN_RENDERER_EVENT_NAME.radio_host_settings_save, { ...patch })
  if (result.ok) radioPlayback.updateSettings(result.values)
  return result
}
