<template>
  <MiniRadio v-if="miniRadioMode" @settings="showSettings" />
  <div v-if="fullLayoutReady" v-show="!miniRadioMode" id="container" class="view-container">
    <layout-aside id="left" />
    <div id="right">
      <layout-toolbar id="toolbar" />
      <layout-view id="view" />
      <layout-play-bar id="player" />
    </div>
    <layout-icons />
    <layout-change-log-modal />
    <layout-update-modal />
    <layout-sync-mode-modal />
    <layout-sync-auth-code-modal />
    <layout-play-detail />
    <button v-if="isMiniRadioWindow" class="return-radio" type="button" @click="returnRadio">返回电台</button>
  </div>
  <layout-pact-modal />
</template>

<script setup>
import { onMounted, ref, watch } from '@common/utils/vueTools'
// import BubbleCursor from '@common/utils/effects/cursor-effects/bubbleCursor'
// import '@common/utils/effects/snow.min'
import useApp from '@renderer/core/useApp'
import MiniRadio from '@renderer/components/radio/MiniRadio.vue'
import { isMiniRadioWindow, miniRadioMode, miniRadioSize } from '@renderer/core/radio/mode'
import { setWindowSize } from '@renderer/utils/ipc'
import { windowSizeActive } from '@renderer/store'
import { useRouter } from '@common/utils/vueRouter'

useApp()
const router = useRouter()
// Initialize settings only when needed, then preserve their mounted state.
const fullLayoutReady = ref(!isMiniRadioWindow)
const showSettings = async() => {
  // Mount the full layout only after navigation, so Search's initial query
  // watchers cannot redirect the new settings navigation.
  await router.push('/setting')
  fullLayoutReady.value = true
  miniRadioMode.value = false
  setWindowSize(windowSizeActive.value.width, windowSizeActive.value.height)
}
const returnRadio = () => {
  miniRadioMode.value = true
  setWindowSize(miniRadioSize.width, miniRadioSize.height)
}
watch(miniRadioMode, mini => {
  document.documentElement.classList.toggle('mini-radio', mini)
}, { immediate: true })

onMounted(() => {
  document.getElementById('root').style.display = 'block'

  // const styles = getComputedStyle(document.documentElement)
  // window.lxData.bubbleCursor = new BubbleCursor({
  //   fillStyle: styles.getPropertyValue('--color-primary-alpha-900'),
  //   strokeStyle: styles.getPropertyValue('--color-primary-alpha-700'),
  // })
})

// onBeforeUnmount(() => {
//   window.lxData.bubbleCursor?.destroy()
// })

</script>


<style lang="less">
@import './assets/styles/index.less';
@import './assets/styles/layout.less';

html {
  height: 100vh;
}
html, body {
  // overflow: hidden;
  box-sizing: border-box;
}

body {
  user-select: none;
  height: 100%;
}
#root {
  height: 100%;
  position: relative;
  overflow: hidden;
  color: var(--color-font);
  background: var(--background-image) var(--background-image-position) no-repeat;
  background-size: var(--background-image-size);
  transition: background-color @transition-normal;
  background-color: var(--color-content-background);
  box-sizing: border-box;
}

.disableAnimation * {
  transition: none !important;
  animation: none !important;
}

.transparent {
  background: transparent;
  padding: @shadow-app;
  // #waiting-mask {
  //   border-radius: @radius-border;
  //   left: @shadow-app;
  //   right: @shadow-app;
  //   top: @shadow-app;
  //   bottom: @shadow-app;
  // }
  #body {
    border-radius: @radius-border;
  }
  #root {
    box-shadow: 0 0 @shadow-app rgba(0, 0, 0, 0.5);
    border-radius: @radius-border;
  }
  // #container {
    // border-radius: @radius-border;
    // background-color: transparent;
  // }
}
.disableTransparent {
  background-color: var(--color-content-background);

  &.linux #body {
    border: 1px solid var(--color-primary-light-500);
  }
  &.windows:not(.windows-11, .fullscreen) #body {
    border-top: 1px solid #aaa;
  }

  #right {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }

  // #view { // 偏移5px距离解决非透明模式下右侧滚动条无法拖动的问题
  //   margin-right: 5Px;
  // }
}
.fullscreen {
  background-color: var(--color-content-background);

  #right {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }
}

#container {
  position: relative;
  display: flex;
  height: 100%;
  background-color: var(--color-app-background);
}

#left {
  flex: none;
  width: @width-app-left;
}
#right {
  flex: auto;
  display: flex;
  flex-flow: column nowrap;
  transition: background-color @transition-normal;
  background-color: var(--color-main-background);

  border-top-left-radius: @radius-border;
  border-bottom-left-radius: @radius-border;
  overflow: hidden;
  box-shadow: 0px 0px 4px rgba(0, 0, 0, 0.1);
}
#toolbar, #player {
  flex: none;
}
#view {
  position: relative;
  flex: auto;
  // display: flex;
  min-height: 0;
}

.view-container {
  transition: opacity @transition-normal;
}
.return-radio {
  position: absolute;
  z-index: 5;
  right: 18px;
  top: 64px;
  padding: 6px 10px;
  border: 1px solid var(--color-primary);
  border-radius: 5px;
  color: var(--color-font);
  background: var(--color-app-background);
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.mini-radio {
  &.transparent { padding: 0; }
  #root { background: #213b48; border-radius: 0; }
}
#root.show-modal > .view-container {
  opacity: .9;
}
#view.show-modal > .view-container {
  opacity: .2;
}

</style>

