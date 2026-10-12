<template lang="pug">
dt#mcp {{ $t('setting__mcp') }}
dd.gap-top
  div
    .p
      base-checkbox(id="setting_mcp_enable" :model-value="appSetting['mcp.enable']" :label="$t('setting__mcp_enable')" @update:model-value="updateSetting({ 'mcp.enable': $event })")
    .p.gap-top
      base-checkbox(id="setting_mcp_bind_lan" :model-value="appSetting['mcp.bindLan']" :label="$t('setting__mcp_bind_lan')" @update:model-value="updateSetting({ 'mcp.bindLan': $event })")
    .p.gap-top.small
      | {{ $t('setting__mcp_address') }}
      span.select {{ mcp.address }}
    .p.small(v-if="mcp.message") {{ mcp.message }}
    .p
      .p.small {{ $t('setting__mcp_port') }}
      div
        base-input.gap-left(:class="$style.portInput" :model-value="appSetting['mcp.port']" type="number" :placeholder="$t('setting__mcp_port_tip')" @update:model-value="setPort")

dd.gap-top
  div
    .p.small {{ $t('setting__mcp_tip') }}
</template>

<script>
import { mcp } from '@renderer/store'
import { appSetting, updateSetting } from '@renderer/store/setting'
import { debounce } from '@common/utils'

export default {
  name: 'SettingMcp',
  setup() {
    const setPort = debounce(port => {
      updateSetting({ 'mcp.port': port.trim() })
    }, 500)

    return {
      appSetting,
      updateSetting,
      mcp,
      setPort,
    }
  },
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';
.portInput[disabled], .hostInput[disabled] {
  opacity: .8 !important;
}
</style>
