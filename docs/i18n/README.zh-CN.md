# Locale Jacket

[English](../../README.md) · **简体中文** · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Русский](README.ru.md) · [Português (Brasil)](README.pt-BR.md)

> 本文是英文 README 的翻译。如有出入，以[英文版](../../README.md)为准；开发与技术细节也请参阅英文版。

Locale Jacket 是一个 Chrome / Edge（Manifest V3）扩展：**按网站**让网页看到不同的浏览器语言（例如 google.com 看到 `en-US`，apple.com 看到 `ja-JP`），而浏览器自身的界面语言（例如简体中文）保持不变。

它把 **开发者工具 ▸ 传感器 ▸ 语言区域（Locale）** 的效果自动应用到所有匹配的标签页，无需打开开发者工具。规则写法与 Clash、sing-box、Shadowrocket 相同：`DOMAIN`、`DOMAIN-SUFFIX`、`DOMAIN-KEYWORD`、`DOMAIN-REGEX`、`GEOSITE`、`IP-CIDR`、`IP-CIDR6`、`IP-ASN`、`GEOIP`，并支持 `SYSTEM`/`DIRECT` 例外和默认操作。

## 功能

| 网站读取到的内容 | 伪装方式 | 覆盖范围 |
|---|---|---|
| `Intl.*`（DateTimeFormat、NumberFormat、Collator、`toLocaleString` 等） | `Emulation.setLocaleOverride` | 页面、同站与跨站框架、专用 Worker |
| `navigator.language`、`navigator.languages` | 仅设置 `acceptLanguage` 的 `Emulation.setUserAgentOverride`（User-Agent 与客户端提示保持不变） | 页面、框架、专用 Worker |
| HTTP `Accept-Language` | 同上，并对首个文档请求使用 `declarativeNetRequest` | 文档、子资源、`fetch()`、Worker 请求 |
| 时区、地理位置 | **默认关闭**，可按规则开启 | 页面与框架 |

- 不篡改任何网页 JavaScript API，完全使用 Chrome 自带的模拟功能。
- 所有处理都在本地完成：没有服务器、账号或遥测。
- 界面支持 10 种语言（见下文）。

## 安装

**从 Release 安装（推荐）**
1. 在 GitHub 的 Releases 页面下载 `locale-jacket-<版本>.zip` 并解压。
2. 打开 `chrome://extensions`（Edge：`edge://extensions`），开启“开发者模式”，点击“加载已解压的扩展程序”，选择解压后的文件夹。
3. 固定扩展图标，徽标（如 `EN`、`JA`）会显示当前标签页使用的语言配置。若要在无痕窗口中使用，请在扩展详情页开启“在无痕模式下启用”。

**升级**：从上一个版本的已解压文件夹升级时，可以使用 `locale-jacket-<旧版本>-to-<新版本>.diff.zip`。它只包含新增或修改过的文件：复制覆盖到旧文件夹，删除 `DELETED.txt` 中列出的文件（如有），然后重新加载扩展即可。扩展 ID 和设置都会保留。

**`.crx` 文件**：使用同一密钥签名（ID `jenefdmhnbfepiohiplfobageceacokb`），但 Chrome / Edge 只有在企业策略允许时才会安装商店以外的 `.crx`。个人使用请选择“加载已解压的扩展程序”。

**从源码构建**：需要 Node.js 20+，然后执行 `npm install` 和 `npm run build`，加载生成的 `dist/` 目录。支持 Chrome / Edge 125 及以上版本（在 155 上开发和测试）。

**首次运行的规则**：首次安装时，扩展会读取文件夹中的 `presets/default-rules.yaml`（与“导入 / 导出”格式相同）。在加载文件夹之前编辑它，即可从你自己的规则开始。`.crx` 不包含此文件，会自动生成相同的示例预设。

## 默认规则

| 规则 | 结果 |
|---|---|
| `DOMAIN-SUFFIX,google.com` | `en-US` |
| `DOMAIN-SUFFIX,openai.com` | `en-US` |
| `DOMAIN-SUFFIX,apple.com` | `ja-JP` |
| `DOMAIN-SUFFIX,yahoo.co.jp` | `ja-JP` |
| `DOMAIN,accounts.google.com` | `SYSTEM`（保持真实语言） |
| 默认 | `SYSTEM` |

可以在弹窗或“选项”页面中随意修改或删除。

## 调试提示栏

只要有标签页处于伪装状态，Chrome 就会显示 **“Locale Jacket 已开始调试此浏览器”**。这是 Chrome 针对 `chrome.debugger` API 的安全提示，扩展不会隐藏它。点击“取消”会暂停 Locale Jacket，之后可在弹窗中点击“恢复”。

如果你接受其中的安全取舍，可以使用 [`tools/chrome-banner-flag.ps1`](../../tools/chrome-banner-flag.ps1)（Windows）为 Chrome 添加 `--silent-debugger-extension-api` 启动参数。注意：这会对**所有**使用调试权限的扩展隐藏该提示。详细说明见[英文 README](../../README.md#hiding-the-debugging-banner-optional)。

## 使用

**弹窗**（工具栏图标）：全局开关；当前标签页匹配的规则、语言配置和状态；“检查网页实际读取到的值”；为当前网站添加或修改规则；设置其他所有网站的默认操作。

**选项页面**：
- **规则**：启用 / 停用、排序、编辑、删除，并标出重复、冲突和多余的规则。
- **测试与验证**：输入主机名查看匹配的规则及原因，或检查已打开的标签页实际报告的值。
- **导入 / 导出**：JSON 或 YAML，可替换或合并。
- **数据集**：GeoSite / GeoIP / ASN 数据的下载、导入和自动更新。
- **设置**：界面语言、框架模式等。
- **会话与日志**：正在调试的标签页及内存中的活动日志。

## 规则

```yaml
rules:
  - type: DOMAIN-SUFFIX        # google.com 及其所有子域名（按标签边界）
    domain: google.com
    locale: en-US
  - type: DOMAIN               # 仅精确匹配该主机名
    domain: accounts.google.com
    action: SYSTEM             # 保持浏览器真实语言（DIRECT 为别名）
  - type: DOMAIN-KEYWORD       # 主机名包含该文本
    keyword: microsoft
    locale: en-GB
  - DOMAIN-SUFFIX,yahoo.co.jp,ja-JP   # 也支持 Clash 风格的简写
  - GEOSITE,google,en-US              # 需要 GeoSite 数据集
  - IP-CIDR,17.0.0.0/8,en-US          # 服务器地址位于该网段
  - GEOIP,LAN,SYSTEM                  # 私有地址，无需数据
default:
  mode: SYSTEM                 # 或 mode: PROFILE + locale/languages/…
```

**优先级**（结果确定，第一个不同点决定胜负）：
1. 规则类型：`DOMAIN` › `DOMAIN-SUFFIX` › `DOMAIN-KEYWORD` › `DOMAIN-REGEX` › `GEOSITE` › `IP-CIDR`/`IP-CIDR6` › `IP-ASN` › `GEOIP`。主机名规则始终优先于 IP 规则。
2. 同类规则中越具体越优先（标签更多的后缀、前缀更长的网段）。
3. `priority` 数值更大者优先。
4. 列表中位置靠前者优先。
5. 没有规则匹配时才使用默认操作。

因此无论顺序如何，`DOMAIN,accounts.google.com → SYSTEM` 都会覆盖 `DOMAIN-SUFFIX,google.com → en-US`。

## 规则订阅

*选项 ▸ 订阅* 会从网上的 JSON 或 YAML 文件（与*导入 / 导出*格式相同）获取规则并保持最新：添加后立即获取，之后每天（或每周、每月、从不）用条件请求更新。GitHub 文件页面（`github.com/…/blob/…`）或 gist 的链接会转换为原始文件；返回网页的地址会被拒绝并给出说明。订阅规则与你自己的规则分开保存，只能查看：顺序为：你的规则、订阅规则、你的特殊规则（GEOSITE 和 IP 规则）、订阅的特殊规则；订阅之间排在上面的优先。文件中只读取 `rules`，无效条目会被跳过。如果订阅规则需要 GeoSite、GeoIP 或 ASN 而该数据集未安装，会自动下载——优先使用文件中 `datasets:` 指定的地址，否则使用默认地址。

## 数据集与自动更新

`GEOSITE`、`GEOIP` 国家/地区和 `IP-ASN` 规则需要数据文件。除非你主动要求，否则不会下载任何内容：在“选项 ▸ 数据集”中从可编辑的地址下载，或导入本地文件。

**自动更新**（可选，默认关闭）：可在浏览器启动时和/或每天、每周、每月检查已下载的数据集。“最短间隔”（默认 24 小时，可设 1–720 小时）限制每个数据集的自动尝试次数，失败的尝试也计算在内，因此反复重启浏览器也不会重复下载。请求是条件请求，文件未变化时不会重新下载。从文件导入的数据集不会自动更新。

IP 规则使用 Chrome 实际连接的服务器地址，扩展不会进行 DNS 查询。

## 界面语言

弹窗和选项页面支持 English、简体中文、繁體中文、日本語、한국어、Deutsch、Français、Español、Русский、Português (Brasil)。默认跟随浏览器界面语言，可在“选项 ▸ 设置 ▸ 界面语言”中更改。此设置不会影响网站看到的语言。

## 更新

已安装的版本显示在弹出窗口标题旁和选项页侧边栏底部。*选项 ▸ 更新* 用于检查新版本：只有在你点击 **立即检查** 或开启自动检查（默认关闭，最多每 12 小时一次）时才会检查，并且只访问页面上显示的发布地址。发现新版本时，弹出窗口会显示提示，页面会显示发布说明、下载链接（差异包、zip、crx）和更新步骤。Chrome 不会自行更新已解压的文件夹：请把新文件复制到文件夹中覆盖，然后点击 **重新加载扩展**。在 GitHub 仓库保持私有期间，GitHub 会返回 404，页面会说明这一点。

## 隐私与权限

所有处理都在本地完成。除了你在“数据集”中发起的下载和你开启的自动更新（均从所示地址获取）、你在“更新”中发起或开启的更新检查（只访问所示的发布地址），以及你在“订阅”中添加的订阅（访问其地址，以及其规则所需的数据集）外，扩展不会发起任何网络请求。规则保存在 `chrome.storage.local`；活动日志只保存在内存中，且只包含主机名。

权限：`debugger`（模拟功能本身）、`webNavigation` 与网站访问权限、`declarativeNetRequestWithHostAccess`（首个请求的 Accept-Language）、`webRequest`（IP 规则所需的服务器地址，以及判断页面加载能否安全重新开始，仅观察）、`alarms`（定时检查数据集和扩展更新，仅在开启时）、`storage`。

## 限制

- 调试提示栏无法由扩展隐藏（见上文）。
- `chrome://`、`edge://` 页面、新标签页、应用商店及被策略禁止的网站无法调试。
- 从新标签页直接输入网址时，页面最早的脚本可能看到真实语言；HTTP 请求头仍然正确，页面可自动重新加载一次。
- 每个渲染进程只能有一种 Intl 语言；共享进程的不同配置会显示为“部分生效”。
- Service Worker 与共享 Worker 不会被覆盖。

完整说明见 [docs/LIMITATIONS.md](../LIMITATIONS.md)，常见问题见 [docs/TROUBLESHOOTING.md](../TROUBLESHOOTING.md)（英文）。

## 许可证

GPL-3.0，见 [LICENSE](../../LICENSE)。
