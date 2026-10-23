# Locale Jacket

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Русский](README.ru.md) · **Português (Brasil)**

> Este documento é uma tradução do README em inglês. Em caso de diferença, vale a [versão em inglês](../../README.md), que também traz os detalhes técnicos e de desenvolvimento.

O Locale Jacket é uma extensão para Chrome / Edge (Manifest V3) que faz os sites verem **uma localidade de navegador diferente para cada site** (por exemplo `en-US` no google.com e `ja-JP` no apple.com), enquanto o idioma da interface do próprio navegador continua o mesmo.

Ela automatiza o que **Ferramentas para desenvolvedores ▸ Sensores ▸ Localidade** faz e aplica isso a cada guia correspondente, sem abrir as ferramentas para desenvolvedores. As regras funcionam como no Clash, sing-box ou Shadowrocket: `DOMAIN`, `DOMAIN-SUFFIX`, `DOMAIN-KEYWORD`, `DOMAIN-REGEX`, `GEOSITE`, `IP-CIDR`, `IP-CIDR6`, `IP-ASN` e `GEOIP`, com exceções `SYSTEM`/`DIRECT` e uma ação padrão.

## Recursos

| O que o site vê | Como é disfarçado | Alcance |
|---|---|---|
| `Intl.*` (DateTimeFormat, NumberFormat, Collator, `toLocaleString` …) | `Emulation.setLocaleOverride` | Página, frames do mesmo site e entre sites, workers dedicados |
| `navigator.language`, `navigator.languages` | `Emulation.setUserAgentOverride` **apenas** com `acceptLanguage` (User-Agent e client hints não mudam) | Página, frames, workers dedicados |
| Cabeçalho HTTP `Accept-Language` | A mesma substituição, mais `declarativeNetRequest` para a primeira solicitação do documento | Documentos, sub-recursos, `fetch()`, solicitações de workers |
| Fuso horário, geolocalização | **Desativados por padrão**, ativáveis por regra | Página e frames |

- Nenhuma API JavaScript da página é modificada: só a emulação do próprio Chrome é usada.
- Tudo roda localmente: sem servidor, conta ou telemetria.
- A interface está em 10 idiomas (veja abaixo).

## Instalação

**A partir de uma release (recomendado)**
1. Na página *Releases* do GitHub, baixe `locale-jacket-<versão>.zip` e descompacte.
2. Abra `chrome://extensions` (Edge: `edge://extensions`), ative o **Modo do desenvolvedor**, clique em **Carregar sem compactação** e escolha a pasta descompactada.
3. Fixe a extensão: o selo (por exemplo `EN` ou `JA`) mostra o perfil da guia atual. Para janelas anônimas, ative **Permitir no modo anônimo** nos detalhes da extensão.

**Atualizar:** para uma pasta sem compactação da versão anterior, use `locale-jacket-<anterior>-to-<nova>.diff.zip`. Ele contém só os arquivos adicionados ou alterados: copie-os sobre a pasta antiga, exclua os arquivos listados em `DELETED.txt` (se houver) e recarregue a extensão. O ID da extensão e suas configurações são mantidos.

**Arquivo `.crx`:** assinado com a mesma chave (ID `jenefdmhnbfepiohiplfobageceacokb`), mas o Chrome e o Edge só instalam `.crx` de fora das lojas quando uma política empresarial permite. Para uso pessoal, use **Carregar sem compactação**.

**A partir do código-fonte:** requer Node.js 20+. Execute `npm install` e `npm run build` e carregue a pasta `dist/` gerada. Compatível com Chrome / Edge 125 ou mais recente (desenvolvido e testado no 155).

**Regras da primeira execução:** numa instalação nova, a extensão lê `presets/default-rules.yaml` da própria pasta (mesmo formato de *Importar / exportar*). Edite esse arquivo antes de carregar a pasta para começar com suas próprias regras. O `.crx` não contém esse arquivo e gera a mesma predefinição de exemplo por conta própria.

## Regras padrão

| Regra | Resultado |
|---|---|
| `DOMAIN-SUFFIX,google.com` | `en-US` |
| `DOMAIN-SUFFIX,openai.com` | `en-US` |
| `DOMAIN-SUFFIX,apple.com` | `ja-JP` |
| `DOMAIN-SUFFIX,yahoo.co.jp` | `ja-JP` |
| `DOMAIN,accounts.google.com` | `SYSTEM` (localidade real) |
| padrão | `SYSTEM` |

Você pode alterá-las ou excluí-las à vontade no pop-up ou na página de opções.

## Barra de depuração

Enquanto alguma guia estiver disfarçada, o Chrome mostra **“Locale Jacket começou a depurar este navegador”**. É o aviso de segurança do Chrome para a API `chrome.debugger`; a extensão não o esconde. Clicar em **Cancelar** pausa o Locale Jacket até você clicar em **Retomar** no pop-up.

Se você aceitar essa troca de segurança, [`tools/chrome-banner-flag.ps1`](../../tools/chrome-banner-flag.ps1) (Windows) adiciona ao Chrome a opção de inicialização `--silent-debugger-extension-api`. Isso esconde o aviso para **todas** as extensões com permissão de depuração. Detalhes no [README em inglês](../../README.md#hiding-the-debugging-banner-optional).

## Uso

**Pop-up** (ícone da barra de ferramentas): botão geral; regra, perfil e status da guia atual; “Verificar o que a página vê”; criar ou alterar a regra do site atual; ação padrão para todos os outros sites.

**Página de opções:**
- **Regras:** ativar / desativar, reordenar, editar, excluir; duplicadas, conflitos e regras redundantes são sinalizados.
- **Testar e verificar:** digite um nome de host para ver quais regras correspondem e por quê, ou verifique o que uma guia aberta realmente informa.
- **Importar / exportar:** JSON ou YAML, substituindo ou mesclando.
- **Conjuntos de dados:** download, importação e atualização automática dos dados GeoSite / GeoIP / ASN.
- **Configurações:** idioma de exibição, modo de frames e mais.
- **Sessões e registro:** guias em depuração e registro de atividades na memória.

## Regras

```yaml
rules:
  - type: DOMAIN-SUFFIX        # google.com e todos os subdomínios (por rótulos)
    domain: google.com
    locale: en-US
  - type: DOMAIN               # somente este nome de host exato
    domain: accounts.google.com
    action: SYSTEM             # manter a localidade real (DIRECT é um apelido)
  - type: DOMAIN-KEYWORD       # o nome de host contém o texto
    keyword: microsoft
    locale: en-GB
  - DOMAIN-SUFFIX,yahoo.co.jp,ja-JP   # a forma curta do Clash também é aceita
  - GEOSITE,google,en-US              # requer o conjunto de dados GeoSite
  - IP-CIDR,17.0.0.0/8,en-US          # endereço do servidor no intervalo
  - GEOIP,LAN,SYSTEM                  # endereços privados, sem dados
default:
  mode: SYSTEM                 # ou: mode: PROFILE + locale/languages/…
```

**Precedência** (determinística; decide a primeira diferença):
1. Tipo de regra: `DOMAIN` › `DOMAIN-SUFFIX` › `DOMAIN-KEYWORD` › `DOMAIN-REGEX` › `GEOSITE` › `IP-CIDR`/`IP-CIDR6` › `IP-ASN` › `GEOIP`. Regras de nome de host sempre vencem regras de IP.
2. Dentro de um tipo vence a mais específica (sufixo com mais rótulos, intervalo de IP com prefixo mais longo).
3. Vence a maior `priority`.
4. Vence a posição mais alta na lista.
5. A ação padrão só se aplica quando nada corresponde.

Por isso `DOMAIN,accounts.google.com → SYSTEM` sempre prevalece sobre `DOMAIN-SUFFIX,google.com → en-US`, qualquer que seja a ordem.

## Assinaturas de regras

*Opções ▸ Assinaturas* busca regras em arquivos JSON ou YAML na internet (no formato de *Importar / exportar*) e as mantém atualizadas: logo ao adicionar e depois todo dia (ou toda semana, todo mês ou nunca), com solicitações condicionais. Links para a página de um arquivo no GitHub (`github.com/…/blob/…`) ou para um gist são convertidos no arquivo bruto; um endereço que devolve uma página web é recusado com uma explicação. As regras de assinatura ficam guardadas à parte das suas e só são exibidas: ordem: suas regras, as de assinatura, suas regras especiais (GEOSITE e regras de IP) e as especiais das assinaturas; entre assinaturas, vence a que está mais acima. De um arquivo só se lê `rules`; itens inválidos são ignorados. Se as regras de uma assinatura precisam de GeoSite, GeoIP ou ASN e esse conjunto de dados não está instalado, ele é baixado automaticamente do endereço que o arquivo indica em `datasets:` ou, se não houver, do endereço padrão.

## Conjuntos de dados e atualizações automáticas

As regras `GEOSITE`, `GEOIP` de país e `IP-ASN` precisam de arquivos de dados. Nada é baixado sem que você peça: em *Opções ▸ Conjuntos de dados*, baixe-os de uma URL editável ou importe um arquivo local.

**Atualizações automáticas** (opcionais, desativadas por padrão): verificar os conjuntos de dados baixados ao iniciar o navegador e/ou todo dia, semana ou mês. Um **tempo mínimo** (24 h por padrão, de 1 a 720 h) limita cada conjunto a uma tentativa automática por período, incluindo as que falharam, para que reiniciar o navegador nunca cause downloads repetidos. As solicitações são condicionais; um arquivo sem alterações não é baixado de novo. Arquivos importados nunca são atualizados automaticamente.

As regras de IP usam o endereço ao qual o Chrome realmente se conectou; a extensão não faz consultas DNS.

## Idioma da interface

O pop-up e a página de opções estão em English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español, Русский e Português (Brasil). Por padrão seguem o idioma do navegador; dá para mudar em *Opções ▸ Configurações ▸ Idioma de exibição*. Isso nunca muda o que os sites veem.

## Atualizações

A versão instalada aparece ao lado do título do pop-up e no rodapé da barra lateral das opções. *Opções ▸ Atualizações* procura uma versão mais nova: só quando você clica em **Verificar agora** ou ativa as verificações automáticas (desativadas por padrão, no máximo uma a cada 12 horas), e só no endereço de publicação mostrado. Se houver uma versão nova, o pop-up mostra um aviso e a página mostra as notas da versão, os links de download (pacote de diferenças, zip, crx) e os passos para atualizar. O Chrome nunca atualiza sozinho uma pasta sem compactação: copie os arquivos novos por cima da pasta e clique em **Recarregar a extensão**. Enquanto o repositório no GitHub for privado, o GitHub responde 404; a página explica isso.

## Privacidade e permissões

Tudo roda localmente. Além dos downloads de conjuntos de dados que você inicia e das atualizações automáticas que você ativa (sempre a partir da URL mostrada), das verificações de atualização que você inicia ou ativa em *Atualizações* (apenas para o endereço de publicação mostrado) e das assinaturas que você adiciona em *Assinaturas* (para os endereços delas, mais os conjuntos de dados de que as regras delas precisam), a extensão não faz solicitações de rede. As regras ficam em `chrome.storage.local`; o registro de atividades existe só na memória e contém apenas nomes de host.

Permissões: `debugger` (a própria emulação), `webNavigation` e acesso a sites, `declarativeNetRequestWithHostAccess` (Accept-Language da primeira solicitação), `webRequest` (endereços de servidor para regras de IP e se um carregamento de página pode ser reiniciado com segurança; apenas observação), `alarms` (verificação programada de atualizações, apenas se ativada), `storage`.

## Limitações

- A extensão não consegue esconder a barra de depuração (veja acima).
- Páginas `chrome://` e `edge://`, a página Nova guia, as lojas de extensões e sites bloqueados por política não podem ser depurados.
- Ao digitar uma URL diretamente numa nova guia, os primeiros scripts podem ver a localidade real; o cabeçalho HTTP continua correto e a página pode ser recarregada automaticamente uma vez.
- Há só uma localidade do Intl por processo de renderização; perfis diferentes que compartilham um processo aparecem como “Parcial”.
- Service workers e shared workers não são substituídos.

Mais detalhes em [docs/LIMITATIONS.md](../LIMITATIONS.md) e ajuda em [docs/TROUBLESHOOTING.md](../TROUBLESHOOTING.md) (em inglês).

## Licença

GPL-3.0, veja [LICENSE](../../LICENSE).
