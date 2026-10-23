# Locale Jacket

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · **한국어** · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Русский](README.ru.md) · [Português (Brasil)](README.pt-BR.md)

> 이 문서는 영어 README의 번역입니다. 내용이 다를 경우 [영어판](../../README.md)이 우선하며, 개발 및 기술 세부 사항도 영어판을 참고하세요.

Locale Jacket은 Chrome / Edge(Manifest V3) 확장 프로그램으로, **사이트별로** 웹사이트가 보는 브라우저 로캘을 바꿉니다(예: google.com에는 `en-US`, apple.com에는 `ja-JP`). 브라우저 자체의 UI 언어는 바뀌지 않습니다.

**개발자 도구 ▸ 센서 ▸ 로캘**과 같은 효과를 개발자 도구를 열지 않고도 일치하는 모든 탭에 자동으로 적용합니다. 규칙은 Clash, sing-box, Shadowrocket과 같은 방식으로 작성합니다: `DOMAIN`, `DOMAIN-SUFFIX`, `DOMAIN-KEYWORD`, `DOMAIN-REGEX`, `GEOSITE`, `IP-CIDR`, `IP-CIDR6`, `IP-ASN`, `GEOIP`. `SYSTEM`/`DIRECT` 예외와 기본 동작도 지원합니다.

## 기능

| 사이트가 읽는 값 | 위장 방식 | 적용 범위 |
|---|---|---|
| `Intl.*`(DateTimeFormat, NumberFormat, Collator, `toLocaleString` 등) | `Emulation.setLocaleOverride` | 페이지, 같은 사이트 / 교차 사이트 프레임, 전용 Worker |
| `navigator.language`, `navigator.languages` | `acceptLanguage`만 지정한 `Emulation.setUserAgentOverride`(User-Agent와 클라이언트 힌트는 그대로) | 페이지, 프레임, 전용 Worker |
| HTTP `Accept-Language` | 위와 같음, 첫 문서 요청에는 `declarativeNetRequest`도 사용 | 문서, 하위 리소스, `fetch()`, Worker 요청 |
| 시간대, 위치 정보 | **기본값 꺼짐**, 규칙별로 사용 | 페이지와 프레임 |

- 페이지의 JavaScript API를 바꾸지 않고 Chrome 자체의 에뮬레이션 기능만 사용합니다.
- 모든 작업은 로컬에서 실행됩니다. 서버, 계정, 원격 분석이 없습니다.
- UI는 10개 언어를 지원합니다(아래 참고).

## 설치

**릴리스에서 설치(권장)**
1. GitHub의 Releases 페이지에서 `locale-jacket-<버전>.zip`을 다운로드하고 압축을 풉니다.
2. `chrome://extensions`(Edge: `edge://extensions`)를 열고 "개발자 모드"를 켠 뒤 "압축해제된 확장 프로그램을 로드합니다"를 눌러 압축을 푼 폴더를 선택합니다.
3. 확장 프로그램을 고정하면 배지(`EN`, `JA` 등)로 현재 탭의 프로필을 확인할 수 있습니다. 시크릿 창에서 사용하려면 확장 프로그램 세부정보에서 "시크릿 모드에서 허용"을 켭니다.

**업데이트**: 이전 버전의 압축해제 폴더에서 업그레이드할 때는 `locale-jacket-<이전>-to-<새>.diff.zip`을 사용할 수 있습니다. 추가되거나 변경된 파일만 들어 있습니다. 이전 폴더에 덮어쓰고, `DELETED.txt`에 나열된 파일이 있으면 삭제한 뒤 확장 프로그램을 새로고침하세요. 확장 프로그램 ID와 설정은 유지됩니다.

**`.crx` 파일**: 같은 키로 서명되어 있습니다(ID `jenefdmhnbfepiohiplfobageceacokb`). 하지만 Chrome / Edge는 엔터프라이즈 정책이 허용할 때만 스토어 외부의 `.crx`를 설치합니다. 개인 용도라면 "압축해제된 확장 프로그램을 로드합니다"를 사용하세요.

**소스에서 빌드**: Node.js 20 이상이 필요합니다. `npm install`과 `npm run build`를 실행한 뒤 생성된 `dist/`를 로드합니다. Chrome / Edge 125 이상을 지원합니다(155에서 개발 및 테스트).

**첫 실행 규칙**: 새로 설치하면 확장 프로그램이 폴더의 `presets/default-rules.yaml`(가져오기 / 내보내기와 같은 형식)을 읽습니다. 폴더를 로드하기 전에 이 파일을 편집하면 원하는 규칙으로 시작할 수 있습니다. `.crx`에는 이 파일이 없으며 같은 예제 프리셋을 자동으로 생성합니다.

## 기본 규칙

| 규칙 | 결과 |
|---|---|
| `DOMAIN-SUFFIX,google.com` | `en-US` |
| `DOMAIN-SUFFIX,openai.com` | `en-US` |
| `DOMAIN-SUFFIX,apple.com` | `ja-JP` |
| `DOMAIN-SUFFIX,yahoo.co.jp` | `ja-JP` |
| `DOMAIN,accounts.google.com` | `SYSTEM`(실제 로캘 유지) |
| 기본값 | `SYSTEM` |

팝업이나 옵션 페이지에서 자유롭게 수정하거나 삭제할 수 있습니다.

## 디버깅 알림 표시줄

탭을 위장하는 동안 Chrome은 **"Locale Jacket에서 이 브라우저 디버깅을 시작했습니다"**를 표시합니다. 이는 `chrome.debugger` API에 대한 Chrome의 보안 알림이며, 확장 프로그램은 이를 숨기지 않습니다. "취소"를 누르면 Locale Jacket이 일시중지되며 팝업의 "재개"로 다시 시작할 수 있습니다.

보안상의 절충을 받아들인다면 [`tools/chrome-banner-flag.ps1`](../../tools/chrome-banner-flag.ps1)(Windows)로 Chrome에 `--silent-debugger-extension-api` 시작 옵션을 추가할 수 있습니다. 이 옵션은 디버거 권한을 사용하는 **모든** 확장 프로그램의 알림을 숨긴다는 점에 유의하세요. 자세한 내용은 [영어 README](../../README.md#hiding-the-debugging-banner-optional)를 참고하세요.

## 사용 방법

**팝업**(툴바 아이콘): 전체 켜기 / 끄기, 현재 탭에 일치한 규칙·프로필·상태, "페이지가 보는 값 확인", 현재 사이트의 규칙 추가·변경, 다른 모든 사이트의 기본값 설정.

**옵션 페이지**:
- **규칙**: 사용 / 사용 중지, 순서 변경, 편집, 삭제. 중복·충돌·불필요한 규칙을 표시합니다.
- **테스트 및 확인**: 호스트 이름을 입력해 일치하는 규칙과 이유를 보거나, 열린 탭이 실제로 보고하는 값을 확인합니다.
- **가져오기 / 내보내기**: JSON 또는 YAML(바꾸기 또는 병합).
- **데이터 세트**: GeoSite / GeoIP / ASN 데이터 다운로드, 가져오기, 자동 업데이트.
- **설정**: 표시 언어, 프레임 모드 등.
- **세션 및 로그**: 디버깅 중인 탭과 메모리 내 활동 로그.

## 규칙

```yaml
rules:
  - type: DOMAIN-SUFFIX        # google.com과 모든 하위 도메인(레이블 단위)
    domain: google.com
    locale: en-US
  - type: DOMAIN               # 이 호스트 이름과 정확히 같을 때만
    domain: accounts.google.com
    action: SYSTEM             # 실제 브라우저 로캘 유지(DIRECT도 동일)
  - type: DOMAIN-KEYWORD       # 호스트 이름에 이 텍스트 포함
    keyword: microsoft
    locale: en-GB
  - DOMAIN-SUFFIX,yahoo.co.jp,ja-JP   # Clash 형식의 짧은 표기도 지원
  - GEOSITE,google,en-US              # GeoSite 데이터 세트 필요
  - IP-CIDR,17.0.0.0/8,en-US          # 서버 주소가 이 범위에 있음
  - GEOIP,LAN,SYSTEM                  # 사설 주소(데이터 불필요)
default:
  mode: SYSTEM                 # 또는 mode: PROFILE + locale/languages/…
```

**우선순위**(결정적이며, 처음으로 다른 항목에서 결정됨):
1. 규칙 유형: `DOMAIN` › `DOMAIN-SUFFIX` › `DOMAIN-KEYWORD` › `DOMAIN-REGEX` › `GEOSITE` › `IP-CIDR`/`IP-CIDR6` › `IP-ASN` › `GEOIP`. 호스트 이름 규칙이 항상 IP 규칙보다 우선합니다.
2. 같은 유형에서는 더 구체적인 규칙(레이블이 많은 접미사, 접두사가 긴 범위).
3. `priority`가 큰 규칙.
4. 목록에서 앞에 있는 규칙.
5. 아무것도 일치하지 않을 때만 기본값 적용.

따라서 순서와 관계없이 `DOMAIN,accounts.google.com → SYSTEM`이 `DOMAIN-SUFFIX,google.com → en-US`보다 우선합니다.

## 규칙 구독

*옵션 ▸ 구독*은 인터넷의 JSON 또는 YAML 파일(*가져오기 / 내보내기*와 같은 형식)에서 규칙을 가져와 최신 상태로 유지합니다. 추가하는 즉시 가져오고, 이후 매일(또는 매주, 매월, 안 함) 조건부 요청으로 업데이트합니다. GitHub 파일 페이지(`github.com/…/blob/…`)나 gist 링크는 원본 파일로 변환되며, 웹 페이지를 반환하는 주소는 이유와 함께 거부됩니다. 구독 규칙은 내 규칙과 따로 저장되고 표시만 됩니다. 내 규칙이 항상 우선하며, 구독끼리는 위에 있는 것이 우선합니다. 파일에서는 `rules`만 읽고, 잘못된 항목은 건너뜁니다. 구독 규칙에 GeoSite, GeoIP 또는 ASN이 필요한데 해당 데이터 세트가 없으면 파일의 `datasets:`에 적힌 주소에서, 없으면 기본 주소에서 자동으로 다운로드합니다.

## 데이터 세트와 자동 업데이트

`GEOSITE`, `GEOIP`(국가), `IP-ASN` 규칙에는 데이터 파일이 필요합니다. 사용자가 요청하지 않으면 아무것도 다운로드되지 않습니다. "옵션 ▸ 데이터 세트"에서 편집 가능한 URL로 다운로드하거나 로컬 파일을 가져오세요.

**자동 업데이트**(선택 사항, 기본값 꺼짐): 브라우저 시작 시 및/또는 매일·매주·매월 다운로드한 데이터 세트를 확인합니다. "최소 간격"(기본 24시간, 1–720시간)은 실패한 시도를 포함해 데이터 세트별 자동 시도를 제한하므로, 브라우저를 다시 시작해도 다운로드가 반복되지 않습니다. 요청은 조건부이며 변경되지 않은 파일은 다시 다운로드하지 않습니다. 파일에서 가져온 데이터 세트는 자동으로 업데이트되지 않습니다.

IP 규칙은 Chrome이 실제로 연결한 서버 주소를 사용하며, 확장 프로그램은 DNS를 조회하지 않습니다.

## 표시 언어

팝업과 옵션 페이지는 English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español, Русский, Português (Brasil)를 지원합니다. 기본적으로 브라우저 UI 언어를 따르며 "옵션 ▸ 설정 ▸ 표시 언어"에서 바꿀 수 있습니다. 웹사이트가 보는 값에는 영향을 주지 않습니다.

## 업데이트

설치된 버전은 팝업 제목 옆과 옵션 사이드바 아래쪽에 표시됩니다. *옵션 ▸ 업데이트*는 새 버전을 확인합니다. **지금 확인**을 클릭하거나 자동 확인을 켰을 때만(기본값은 꺼짐, 최대 12시간에 한 번) 확인하며, 표시된 릴리스 주소에만 요청합니다. 새 버전이 있으면 팝업에 알림이 나타나고, 페이지에 릴리스 노트, 다운로드 링크(차이 팩, zip, crx), 업데이트 단계가 표시됩니다. Chrome은 압축해제된 폴더를 직접 업데이트하지 않으므로, 새 파일을 폴더에 덮어쓴 다음 **확장 프로그램 새로고침**을 클릭하세요. GitHub 저장소가 비공개인 동안에는 GitHub가 404로 응답하며, 페이지에서 이를 설명합니다.

## 개인정보 및 권한

모든 작업은 로컬에서 실행됩니다. "데이터 세트"에서 직접 시작한 다운로드와 사용자가 켠 자동 업데이트(모두 표시된 URL에서), "업데이트"에서 시작하거나 켠 업데이트 확인(표시된 릴리스 주소로만), 그리고 "구독"에서 추가한 구독(그 주소와 규칙에 필요한 데이터 세트)을 제외하면 확장 프로그램은 네트워크 요청을 보내지 않습니다. 규칙은 `chrome.storage.local`에 저장되고, 활동 로그는 메모리에만 있으며 호스트 이름만 포함합니다.

권한: `debugger`(에뮬레이션 자체), `webNavigation` 및 호스트 액세스, `declarativeNetRequestWithHostAccess`(첫 요청의 Accept-Language), `webRequest`(IP 규칙용 서버 주소와 페이지 로드를 안전하게 다시 시작할 수 있는지 여부, 관찰만), `alarms`(데이터 세트 및 확장 프로그램 업데이트 정기 확인, 켠 경우에만), `storage`.

## 제한 사항

- 디버깅 알림 표시줄은 확장 프로그램이 숨길 수 없습니다(위 참고).
- `chrome://`, `edge://` 페이지, 새 탭 페이지, 웹 스토어, 정책으로 차단된 사이트는 디버깅할 수 없습니다.
- 새 탭에 URL을 직접 입력하면 첫 스크립트가 실제 로캘을 볼 수 있습니다. HTTP 헤더는 올바르며 페이지를 한 번 자동으로 새로고침할 수 있습니다.
- Intl 로캘은 렌더러 프로세스당 하나뿐입니다. 다른 프로필과 프로세스를 공유하면 "부분 적용"으로 표시됩니다.
- 서비스 워커와 공유 워커는 재정의되지 않습니다.

자세한 내용은 [docs/LIMITATIONS.md](../LIMITATIONS.md), 문제 해결은 [docs/TROUBLESHOOTING.md](../TROUBLESHOOTING.md)(영어)를 참고하세요.

## 라이선스

GPL-3.0. [LICENSE](../../LICENSE)를 참고하세요.
