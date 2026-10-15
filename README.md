<p align="center"><a href="https://github.com/lyswhut/lx-music-desktop"><img width="200" src="https://github.com/lyswhut/lx-music-desktop/blob/master/doc/images/icon.png" alt="lx-music logo"></a></p>

<h1 align="center">LX Music 桌面版</h1>

<p align="center">
  <a href="https://github.com/lyswhut/lx-music-desktop/releases"><img src="https://img.shields.io/github/release/lyswhut/lx-music-desktop" alt="Release version"></a>
  <a href="https://github.com/lyswhut/lx-music-desktop/actions/workflows/release.yml"><img src="https://github.com/lyswhut/lx-music-desktop/workflows/Build/badge.svg" alt="Build status"></a>
  <a href="https://github.com/lyswhut/lx-music-desktop/actions/workflows/beta-pack.yml"><img src="https://github.com/lyswhut/lx-music-desktop/workflows/Build%20Beta/badge.svg" alt="Build status"></a>
  <a href="https://electronjs.org/releases/stable"><img src="https://img.shields.io/github/package-json/dependency-version/lyswhut/lx-music-desktop/dev/electron/master" alt="Electron version"></a>
  <!-- <a href="https://github.com/lyswhut/lx-music-desktop/releases"><img src="https://img.shields.io/github/downloads/lyswhut/lx-music-desktop/latest/total" alt="Downloads"></a> -->
  <a href="https://github.com/lyswhut/lx-music-desktop/tree/dev"><img src="https://img.shields.io/github/package-json/v/lyswhut/lx-music-desktop/dev" alt="Dev branch version"></a>
  <!-- <a href="https://github.com/lyswhut/lx-music-desktop/blob/master/LICENSE"><img src="https://img.shields.io/github/license/lyswhut/lx-music-desktop" alt="License"></a> -->
</p>

<!-- [![GitHub release][1]][2]
[![Build status][3]][4]
[![GitHub Releases Download][5]][6]
[![dev branch][7]][8]
[![GitHub license][9]][10] -->

<!-- [1]: https://img.shields.io/github/release/lyswhut/lx-music-desktop
[2]: https://github.com/lyswhut/lx-music-desktop/releases
[3]: https://ci.appveyor.com/api/projects/status/flrsqd5ymp8fnte5?svg=true
[4]: https://ci.appveyor.com/project/lyswhut/lx-music-desktop
[5]: https://img.shields.io/github/downloads/lyswhut/lx-music-desktop/latest/total
[5]: https://img.shields.io/github/downloads/lyswhut/lx-music-desktop/total
[6]: https://github.com/lyswhut/lx-music-desktop/releases
[7]: https://img.shields.io/github/package-json/v/lyswhut/lx-music-desktop/dev
[8]: https://github.com/lyswhut/lx-music-desktop/tree/dev
[9]: https://img.shields.io/github/license/lyswhut/lx-music-desktop
[10]: https://github.com/lyswhut/lx-music-desktop/blob/master/LICENSE -->

<p align="center">一个基于 Electron & Vue 开发的音乐软件</p>

## 说明

所用技术栈：

- Electron 30+
- Vue 3

已支持的平台：

- Linux
- macOS
- Windows 7 及以上

*移动版项目地址：https://github.com/lyswhut/lx-music-mobile*

> [!NOTE]
> 目前新项目 [Any Listen](https://github.com/any-listen/any-listen) 的桌面版、Web 版已实现 LX Music 的大部分功能，并额外支持 WebDAV 歌曲播放、WebDAV 数据同步、独立播放列表等功能。
> 我们以后的开发精力将主要集中在新项目上，之前大家在 LX Music 提的功能我们也会考虑在新项目中添加。
> 对于日常使用 LX Music 的人可以试试迁移到 Any Listen，若遇到任何问题可以发 issue 反馈。
>
> 关于我们开发新项目的原因，可以参考：[LX Music 项目发展调整与新项目计划](https://github.com/lyswhut/lx-music-desktop/issues/1912)。

软件变化请查看[更新日志](https://github.com/lyswhut/lx-music-desktop/blob/master/CHANGELOG.md)。

软件下载请查看 [GitHub Releases](https://github.com/lyswhut/lx-music-desktop/releases)。

使用常见问题请参阅[桌面版常见问题](https://lyswhut.github.io/lx-music-doc/desktop/faq)。

目前本项目的原始发布地址只有 [**GitHub**](https://github.com/lyswhut/lx-music-desktop/releases)，其他渠道均为第三方转载发布，与本项目无关！

为了提高使用门槛，本软件内的默认设置、UI 操作不以新手友好为目标，所以使用前建议先根据你的喜好浏览调整一遍软件设置，阅读一遍[音乐播放列表机制](https://lyswhut.github.io/lx-music-doc/desktop/faq/playlist)及[可用的鼠标、键盘快捷操作](https://lyswhut.github.io/lx-music-doc/desktop/faq/hotkey)。

### Scheme URL 支持

从 v1.17.0 起支持 Scheme URL，可以使用此功能在浏览器等场景下调用 LX Music，我们开发了一个[油猴脚本](https://github.com/lyswhut/lx-music-script#readme)配套使用。

脚本安装地址：[LX Music 辅助脚本](https://greasyfork.org/zh-CN/scripts/438148)。

若你想自己调用 LX Music，可以参考文档「[Scheme URL 支持](https://lyswhut.github.io/lx-music-doc/desktop/scheme-url)」部分。

### 数据同步服务

从 v2.2.0 起，我们发布了一个独立的[数据同步服务](https://github.com/lyswhut/lx-music-sync-server#readme)。如果你有服务器，可以将其部署到服务器上作为私人多端同步服务使用，详情看该项目说明。

### 开放 API 支持

从 v2.7.0 起支持开放 API 服务。启用该功能后，将会在本地启动一个 HTTP 服务，提供播放器相关的接口供第三方软件调用，详情看文档「[开放 API 服务](https://lyswhut.github.io/lx-music-doc/desktop/open-api)」部分。

### 数据存储目录

默认情况下，软件的数据存储在：

- Linux：`$XDG_CONFIG_HOME/lx-music-desktop` 或 `~/.config/lx-music-desktop`
- macOS：`~/Library/Application Support/lx-music-desktop`
- Windows：`%APPDATA%/lx-music-desktop`

在 Windows 平台上，若程序文件夹中存在 `portable` 文件夹，则自动使用此文件夹作为数据存储文件夹（适用于 v1.17.0 及以上版本）。

## 用户界面

<p><img width="100%" src="./doc/images/app.png" alt="lx-music desktop UI"></p>

## 贡献代码

本项目欢迎 PR，但为了 PR 能顺利合并，需要注意以下几点：

- 对于添加新功能的 PR，建议在提交 PR 前先创建 Issue 进行说明，以确认该功能是否确实需要。
- 对于修复 bug 的 PR，请提供修复前后的说明及重现方式。
- 对于其他类型的 PR，则适当附上说明。

贡献代码步骤：

1. 参照[源码使用方法](https://lyswhut.github.io/lx-music-doc/desktop/use-source-code)设置开发环境；
2. 克隆本仓库代码并切换至 `dev` 分支进行开发；
3. 提交 PR 至 `dev` 分支。

## 源码使用方法

请参阅：<https://lyswhut.github.io/lx-music-doc/desktop/use-source-code>

### 本地 AI 电台（macOS）

电台选歌会精确匹配歌名和歌手（含括号别名），不把 DJ、加速、现场或翻唱版本当作原曲；明确指定这些版本时按指定版本匹配。已标注为 30 秒及以下的搜索条目先排除；首选平台找不到匹配时再做聚合搜索，不用搜索第一条顶替。

自动换源也必须保持同一首、同一版本和歌手；两侧都有标注时长时，差异超过 5 秒的候选会被排除。先前选择的其他平台条目同样需要核对。电台使用独立的版本化链接缓存，绕开旧缓存中可能保存的模糊匹配结果，避免把另一首歌的音频挂在当前歌名和主持串词下；普通播放器的缓存与匹配方式保持原样。

电台会在歌曲与片头口播开始前，静音检查链接的实际音频时长；30 秒及以下的试听或占位音频会被排除（含少量编码补帧容差），有标注时长时还会拒绝不足其 80% 的音频，避免 60/90 秒试听混入完整歌曲；标注时长缺失或无效时仍使用 30 秒下限。以实际音频时长为准。缓存链接、新链接和换源链接都会检查；可用音源全部失败后自动跳过这首，本期已拒绝的歌曲不会反复尝试。整期都不可用时停止并提示更换歌单或音源。主持人语音和普通播放器模式不受此长度限制。

电台还会读取返回音频的文件标签，发现标题或歌手与目标歌曲不符时拒绝链接并尝试备用音源；缓存链接也重新核对。读取限于文件开头 256 KiB，并有 4 秒超时，不需要下载整首歌，也不依赖媒体 CDN 的 CORS。缺少标签或标签位于文件末尾时身份仍未知，继续使用严格搜索匹配与实际时长检查；这不是声纹识曲，不能保证发现标签缺失或伪造的错链。

电台开启时会自动维护独立的备用音源池。候选脚本来自 [Macrohard0001/lx-ikun-music-sources](https://github.com/Macrohard0001/lx-ikun-music-sources)，仅下载兼容 LX 的小型脚本，跳过标注需要卡密、账号或自行配置的文件；下载文件保存在播放器用户目录的 `radio-sources.json`，不进入 Git。该合集仅供个人学习、非商业交流，使用时保留其来源与许可说明。

后台每 6 小时检查合集更新，每 20 分钟用最近请求的真实歌曲检查当前和备用音源，探测不播放声音、不会弹出脚本更新或初始化提示。新版本只有返回可播放、超过 30 秒的音频后才会成为可用候选，同一音源的新版本验证成功后用于后续取链接，旧版本保留作回退；GitHub 限流时改读目录 JSON，网络异常保留缓存，15 分钟后重试。普通播放器的音源选择保持原样。

播放失败时优先尝试当前活动源及已导入的备用脚本，再尝试下载的备用脚本和其他平台的同一首歌；不会因前四个脚本失败就提前停止。每个平台最多尝试 20 秒，为其他平台保留重试时间，音源尝试仍共享 65 秒预算。歌曲不可用的冷却只影响该歌曲，初始化失败或平台不支持才冷却整个音源的平台；失效链接不会立即复用。持续缓冲 8 秒后尝试更换链接并恢复当前进度，下一首会在结束前约 60 秒准备链接。全部候选仍不可用时跳过该曲继续节目。自动恢复受网络和第三方服务可用性影响，无法保证所有音源同时失效时仍可播放。诊断可从 MCP 的 `get_radio_sources_status` 查询，包含候选数、活动源、最近更新和巡检时间，以及最近取链尝试的音源名称、耗时、失败原因或有效音频时长（不包含链接和密钥）；正常听歌无需操作。

播放器和 miniagent 的依赖、本地 TTS 模型已安装，且播放器已经构建后，双击项目根目录的 `启动电台.command` 即可。终端会让你选择“完整播放器”“迷你电台”或“不启动客户端，仅连接已运行的播放器”，回车默认选择完整播放器，也可以输入 q 取消。随后脚本启动并预热本地 TTS，在同一个终端启动电台主持人。也可以执行 `npm run start:radio`。

命令行可用 `./启动电台.command --full-player` 启动完整播放器、`./启动电台.command --mini-player` 启动迷你电台，或用 `./启动电台.command --no-player` 仅连接已有播放器，均跳过播放器选择菜单。原来的 `--start-player` 是完整播放器模式的别名。不启动客户端模式不要求本地 Electron 依赖和播放器构建文件；若 MCP 不在线，会直接提示并退出，不会启动 TTS 或主持人。当前音乐播放、主持人口播混音、自动续播和音量渐变仍由 Electron 播放器执行，尚不支持完全没有播放器进程的电台。

看到“电台主持人已上线”后，在终端或迷你电台聊天框输入“来一期 30 分钟的 90 年代华语电台”开始节目。保持终端窗口打开，输入 `exit` 收工；上线后的Ctrl+C取消当前回答或停止聊天语音。脚本会关闭本次启动的播放器和 TTS；之前已经运行的服务继续保留。重复启动会提示回到原来的终端，不会再开一个主持人。

选择迷你电台后，新启动的播放器打开 390 × 520 的小窗口，显示歌曲、进度、音量、主持状态和文字聊天输入框；展开聊天记录时增高至700。Enter发送，Shift+Enter换行，中文输入法确认选字不会发送。可以输入“来一期90年代华语电台”开播，或选择“开新节目”输入主题；播放中直接聊天、点歌，输入“下一首想听周杰伦的晴天”会静默核验后安排为下一首，当前音乐继续，原自动队列保留。聊天先显示文字，再用当前主持人声音回复，不接麦克风。语音独立生成并等待片头或插播结束，讲话时平滑压低音乐，结束后恢复；不占自动插播次数。可随时停止聊天语音，TTS失败时保留文字。等待中的回答可取消，已提交成功的点歌会单独显示结果。输入区旁提供暂停/继续和下一首。右上角齿轮打开主持人设置，也可临时进入完整播放器设置。关闭本次启动的窗口会让主持人收工。已有播放器会原样复用，界面选择只对新窗口生效。

自动主持、文字聊天和直接播放控制独立执行；聊天不会重启节目或停止补歌。电台队列按顺序续播，不改写普通播放器保存的循环模式。点歌和补歌共享队列写入调度，失败或尚在核验时取消点歌不改动队列；已经入队后取消回答不会撤销点歌。聊天通过本机认证的HTTP入口传输，连接信息写入 miniagent 的 `.logs/radio-host.json`，由播放器主进程读取，令牌不进入界面或Git。界面显示等待、核验、回复与错误状态；新消息不会因模型忙碌而阻止输入，聊天模型调用与工具检索仍各自有超时，取消后丢弃迟到结果。

miniagent 默认位于播放器项目的同级目录；其他位置可通过 `RADIO_MINIAGENT_DIR` 指定。播放器设置中的 MCP 服务须启用，端口与 miniagent 的 `radio.toml` 一致（当前预览为 `23332`）。启动文件和服务状态可用 `./启动电台.command --check` 检查，播放器启动日志位于 `.radio-preview/launcher-player.log`。

启动时还会询问是否开启 verbose（回车关闭）；开启后再询问是否用主持人声音播报关键进度。详细日志显示模型调用、搜索关键词与来源数量、TTS 和播放器请求的耗时，长操作每5秒显示仍在等待，并保存到 miniagent 的 `.logs/radio-verbose.jsonl`。语音进度默认关闭，只在等待超过12秒或关键步骤失败时尝试短播报，每分钟最多一次，同一句5分钟内不重复，超过6秒的语音丢弃。常规进度避开音乐播放，问题提示避开正式主持，不占插播次数；过时的提示丢弃，短语音按主持人配置缓存。模型、TTS 或播放器不可用时仍以终端日志为准。新短语音最多请求8秒，后台生成；已经进行中的短生成可能让正式 TTS 多等几秒。

可用 `./启动电台.command --mini-player --verbose --spoken-progress` 跳过三个选择；只看日志使用 `--verbose --no-spoken-progress`，关闭详细日志使用 `--no-verbose`。`--check` 和非交互启动不询问日志选项，非交互默认关闭。

## 项目协议

本项目基于 [Apache License 2.0](https://github.com/lyswhut/lx-music-desktop/blob/master/LICENSE) 许可证发行，以下协议是对于 Apache License 2.0 的补充，如有冲突，以以下协议为准。

---

*词语约定：本协议中的“本项目”指 LX Music（洛雪音乐助手）桌面版项目；“使用者”指签署本协议的使用者；“官方音乐平台”指对本项目内置的包括酷我、酷狗、咪咕等音乐源的官方平台统称；“版权数据”指包括但不限于图像、音频、名字等在内的他人拥有所属版权的数据。*

### 一、数据来源

1.1 本项目的各官方平台在线数据来源原理是从其公开服务器中拉取数据（与未登录状态在官方平台 APP 获取的数据相同），经过对数据简单地筛选与合并后进行展示，因此本项目不对数据的合法性、准确性负责。

1.2 本项目本身没有获取某个音频数据的能力，本项目使用的在线音频数据来源来自软件设置内“自定义源”设置所选择的“源”返回的在线链接。例如播放某首歌，本项目所做的只是将希望播放的歌曲名、艺术家等信息传递给“源”，若“源”返回了一个链接，则本项目将认为这就是该歌曲的音频数据而进行使用，至于这是不是正确的音频数据本项目无法校验其准确性，所以使用本项目的过程中可能会出现希望播放的音频与实际播放的音频不对应或者无法播放的问题。

1.3 本项目的非官方平台数据（例如“我的列表”内列表）来自使用者本地系统或者使用者连接的同步服务，本项目不对这些数据的合法性、准确性负责。

### 二、版权数据

2.1 使用本项目的过程中可能会产生版权数据。对于这些版权数据，本项目不拥有它们的所有权。为了避免侵权，使用者务必在 **24 小时内** 清除使用本项目的过程中所产生的版权数据。

### 三、音乐平台别名

3.1 本项目内的官方音乐平台别名为本项目内对官方音乐平台的一个称呼，不包含恶意。如果官方音乐平台觉得不妥，可联系本项目更改或移除。

### 四、资源使用

4.1 本项目内使用的部分包括但不限于字体、图片等资源来源于互联网。如果出现侵权可联系本项目移除。

### 五、免责声明

5.1 由于使用本项目产生的包括由于本协议或由于使用或无法使用本项目而引起的任何性质的任何直接、间接、特殊、偶然或结果性损害（包括但不限于因商誉损失、停工、计算机故障或故障引起的损害赔偿，或任何及所有其他商业损害或损失）由使用者负责。

### 六、使用限制

6.1 本项目完全免费，且开源发布于 GitHub 面向全世界人用作对技术的学习交流。本项目不对项目内的技术可能存在违反当地法律法规的行为作保证。

6.2 **禁止在违反当地法律法规的情况下使用本项目。** 对于使用者在明知或不知当地法律法规不允许的情况下使用本项目所造成的任何违法违规行为由使用者承担，本项目不承担由此造成的任何直接、间接、特殊、偶然或结果性责任。

### 七、版权保护

7.1 音乐平台不易，请尊重版权，支持正版。

### 八、非商业性质

8.1 本项目仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠。

### 九、接受协议

9.1 若你使用了本项目，即代表你接受本协议。

---

若对此有疑问请 mail to: lyswhut+qq.com (请将 `+` 替换为 `@`)


迷你电台右上角齿轮打开主持人设置，可调46项声音、插播混音、人设、稿件长度、检索和语音高级参数。音量立即试听，保存写入 miniagent 的 `radio.toml`；未保存关闭会撤销试听。语速、尾音、参考录音和人设用于后续生成，已缓存口播不重做；插播次数与最小间隔不改变模型自主选时机。面板保留“打开播放器设置”入口。恢复默认以当前认可的参考声音、0.95语速、1.6主持音量为基准。

一键启动通过 `LX_MINIAGENT_ROOT` 指定配置所在项目，播放器不保管语音或检索密钥；云端语音只设置密钥的环境变量名称。设置保存前校验范围、参考录音与关联字段，失败不会改变配置。读取目录失败时请用电台启动脚本重新打开。新代码首次使用需重新构建并重启播放器和主持人。

主持文案新增“讲述侧重”：默认故事与感受，也可选择感受为主或故事为主。原有抒情、聊天感与台湾式尾音保留，有可靠资料时自然加入歌曲由来、创作和制作故事；新偏好用于后续生成。

电台歌曲查询直接使用各平台的搜索接口，结果由每个请求独立持有，不使用界面搜索状态的过期清空逻辑。并发搜索不同歌曲不会互相覆盖。开播失败区分 `song_search`（未匹配歌曲）与 `audio_validation`（音源不可用或校验失败），媒体身份校验继续保留。主进程异步构建文件带 `main-` 前缀，避免与界面构建互相覆盖；构建后的实际 IPC 验证可运行 `npm run test:radio:bundle`。
