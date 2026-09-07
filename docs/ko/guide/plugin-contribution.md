# 플러그인 기여 가이드

Voyager의 플러그인 시스템은 선언형 플러그인을 우선합니다. `plugin.json`에는 플러그인 정보와 DOM 작업을 적고, CSS에는 시각적 변경을 적습니다. 플러그인은 원격 JavaScript를 실행하지 않으며, Voyager에 내장된 플러그인 엔진이 manifest와 스타일을 해석합니다.

이 방식은 리뷰와 유지보수를 쉽게 만듭니다. 플러그인을 기여하고 싶다면 여기서 시작하는 것을 권장합니다.

## 권장 흐름

1. 먼저 플러그인에 적합한지 확인하세요. 읽기 폭, 레이아웃 수정, 테마 조정, 페이지 요소 숨김 또는 표시, 간단한 사이트 대응은 보통 좋은 후보입니다.
2. Voyager 메인 저장소에 먼저 Issue를 열어 해결하려는 문제, 대상 웹사이트, 기존 플러그인과의 차이를 설명하세요. 유지관리자의 명시적 승인을 받은 뒤 구현과 PR 작성을 시작하세요.
3. `plugin.json`에 메타데이터, 사이트 매칭, 설정, 기여 내용을 작성하세요.
4. 스타일은 같은 디렉터리의 `style.css`에 넣고 `contributes.styles`에서 참조하세요.
5. 로컬에서 테스트한 뒤 PR에 테스트 페이지, 스크린샷 또는 짧은 녹화를 첨부하세요. 유지관리자는 완성도를 보고 공식 catalog 포함 여부를 결정합니다.

## 디렉터리 구조

공식 번들 플러그인은 `src/features/plugins/catalog/` 아래에 있고, 플러그인 플랫폼마다 디렉터리가 하나씩 있습니다.

```
src/features/plugins/catalog/
  marketplace.json                        문서 플러그인 스토어가 읽는 색인
  sites/<site>/site.json                  데이터로 표현한 사이트 어댑터
  sites/<site>/plugins/<id>/plugin.json   선언형 플러그인
  sites/<site>/plugins/<id>/style.css     해당 스타일
  sites/<site>/plugins/<id>/README.md     무엇을 왜 고치는지에 대한 설명
```

탐색은 자동입니다. `catalog/sites/index.ts`가 `import.meta.glob`으로 모든 `site.json`과 `plugin.json`을 찾으므로, 사이트나 플러그인을 추가하는 일은 파일을 추가하는 일입니다. 손으로 관리하는 매핑 표는 없습니다.

`marketplace.json`은 그 매핑 표가 아니라 문서 플러그인 스토어가 읽는 색인입니다. 테스트가 탐색 결과와의 동기화를 강제하므로 새 플러그인은 여기에도 항목을 추가해야 합니다. `source`는 catalog 기준 상대 경로이며, 예를 들어 `sites/deepseek/plugins/reading-width/plugin.json`입니다.

`site.json`은 사이트 어댑터 자체를 데이터로 적은 것입니다. 현재 플러그인 플랫폼은 ChatGPT, Claude, DeepSeek입니다. Gemini와 AI Studio는 Voyager의 네이티브 화면이라 TypeScript 어댑터로 남아 있고, `sites/adapters/claude.ts`, `chatgpt.ts`, `deepseek.ts`는 `site.json`을 감싼 한 줄짜리 껍데기입니다. TypeScript가 아니라 JSON을 수정하세요. 게시되는 호스트별 카탈로그가 사이트 데이터도 함께 싣기 때문에, 선택자 수정은 확장 프로그램을 새로 배포하지 않아도 사용자에게 전달됩니다.

플러그인의 `matches`는 그 플러그인이 속한 사이트의 `matches` 안에 있어야 합니다. 범위를 벗어나면 빌드가 실패합니다.

## 의미 선택자 키

`site.json`은 고정된 의미 키 어휘를 사이트별 CSS 선택자에 연결합니다. 어휘는 `src/features/plugins/sites/semanticKeys.ts`에 정의되어 있고, `site.json`은 이 목록의 키만 사용할 수 있으며 모르는 키는 거부됩니다.

- `userTurn`: 사용자 메시지 컨테이너.
- `assistantTurn`: 어시스턴트 메시지 컨테이너.
- `thinkingBlock`: 어시스턴트 응답 안의 추론 영역.
- `codeBlock`: 렌더링된 코드 블록.
- `composer`: 사용자가 입력하는 프롬프트 입력창.
- `sidebar`: 대화 목록 또는 내비게이션 레일.
- `sidePanel`: artifacts나 canvas 같은 보조 패널.
- `headerActions`: 대화 화면 오른쪽 위의 동작 영역.
- `scrollContainer`: 대화를 스크롤하는 요소.

사이트는 실제로 제공할 수 있는 키만 선언합니다. 플러그인은 선택자를 직접 쓰지 않고 DOM 작업의 `target`에 `{ "kind": "semantic", "key": "userTurn" }`을 적어 키를 참조하므로, 사이트가 개편되어도 `site.json` 한 파일만 고치면 됩니다.

`conversationIdPattern`은 선택자가 아니라 `site.json`의 별도 필드입니다. URL 경로에 대한 정규식이며 첫 번째 캡처 그룹이 대화 id입니다. 예를 들면 `^/chat/([^/?#]+)`입니다.

## 플러그인 범위

플러그인은 플랫폼별로 기계적으로 나누기보다, 사용자가 해결하려는 문제를 기준으로 나누는 것이 좋습니다.

같은 기능이 여러 플랫폼에서 거의 같은 경험과 설정을 제공한다면 하나의 크로스 플랫폼 플러그인을 권장합니다. 예를 들어 읽기 폭, 페이지 넘김 경험, 코드 블록 레이아웃은 여러 `matches`로 Claude, ChatGPT 등을 함께 커버할 수 있습니다.

반대로 플랫폼마다 설정, DOM 로직, 사용자 문구가 완전히 다르다면 여러 플러그인으로 나누는 편이 명확합니다. "하나로 모든 것을 처리"하기 위해 관련 없는 기능을 억지로 넣지 마세요. 하나의 플러그인은 하나의 분명한 문제를 해결하는 것이 가장 좋습니다.

간단한 기준:

- 같은 사용자 목표, 같은 설정, 다른 것은 사이트 선택자뿐: 하나의 플러그인을 우선합니다.
- 같은 주제지만 플랫폼별 경험 차이가 큼: 나눌 수 있지만 이름과 설명의 관련성을 유지합니다.
- 기능 목표가 다름: 합치지 않습니다.

## 중복 플러그인 피하기

제출 전 플러그인 마켓플레이스와 기존 공식 플러그인을 확인하세요. 이미 좋은 플러그인이 있다면 비슷한 것을 새로 만들기보다 기존 플러그인을 개선하는 PR을 우선하세요.

중복 플러그인은 다음처럼 명확한 개선이 있을 때만 받을 가치가 있습니다.

- 기존 플러그인이 지원하지 않는 중요한 플랫폼을 지원합니다.
- 기존 플러그인이 오랫동안 해결하지 못한 호환성 문제를 고칩니다.
- 성능, 접근성, 유지보수성이 명확히 더 좋습니다.
- 이름이나 스타일을 조금 바꾼 수준이 아니라 충분히 다른 사용자 경험을 제공합니다.

이렇게 해야 마켓플레이스가 깔끔해지고 사용자가 선택하기 쉬워집니다.

## 최소 예시

```json
{
  "id": "your-name.example-plugin",
  "name": "Example Plugin",
  "version": "1.0.0",
  "description": "A short description of what this plugin improves.",
  "author": "your-name",
  "category": "readability",
  "license": "MIT",
  "engine": ">=1.0.0",
  "tier": "declarative",
  "matches": ["https://claude.ai/*"],
  "contributes": {
    "styles": [{ "file": "style.css" }],
    "domOps": [
      {
        "op": "addClass",
        "target": "body",
        "className": "gv-plugin-example"
      }
    ]
  }
}
```

`style.css`는 일반 CSS처럼 작성할 수 있지만, 플러그인 스타일은 자신의 `gv-plugin-*` 클래스 아래에 두는 것을 권장합니다.

```css
.gv-plugin-example .some-target {
  max-width: 880px;
}
```

## Manifest 주의사항

- `id`는 `your-name.reading-width`처럼 작성자 접두사나 역도메인 스타일을 사용해 충돌을 피하세요.
- `matches`는 좁게 유지하고, 플러그인이 실제로 필요한 사이트만 포함하세요.
- 여러 플랫폼이 하나의 명확한 기능 목표를 공유한다면 하나의 플러그인에 여러 `matches`를 포함할 수 있습니다.
- `category`는 `render-fix`, `theme`, `layout`, `readability`, `productivity`, `integration`, `other`를 권장합니다.
- 필요한 플러그인 엔진 버전을 `engine`에 명확히 적으세요. 공식 플러그인을 예시로 참고할 수 있습니다.
- `i18n`에는 가능하면 중국어, 영어, 기타 자주 쓰이는 언어의 이름, 설명, 설정 문구를 추가하세요.

## CSS와 리소스 제한

선언형 플러그인은 신뢰할 수 없는 입력으로 검증되므로 리소스를 자체 포함 형태로 유지하세요.

- `@import`를 사용하지 마세요.
- 원격 이미지, 외부 폰트, 원격 CSS를 참조하지 마세요.
- 일반 CSS, 사용자 정의 속성, Voyager가 제공하는 설정값 치환은 사용할 수 있습니다.
- 클래스 이름은 `gv-plugin-` 접두사를 사용해 호스트 사이트나 Voyager 자체 스타일을 오염시키지 않도록 하세요.

설정이 필요하다면 먼저 숫자 설정을 사용하는 것을 권장합니다. 예를 들어 읽기 폭 플러그인은 설정값을 CSS 변수로 쓰고 CSS에서 그 값을 사용할 수 있습니다.

## DOM 작업 범위

현재 선언형 플러그인은 다음 작업을 지원합니다.

- `addClass`: 대상 요소에 클래스를 추가합니다.
- `setAttribute`: 속성을 설정합니다.
- `setStyle`: 인라인 스타일 또는 CSS 변수를 설정합니다.
- `hide`: 대상 요소를 숨깁니다.

대상은 CSS 선택자이거나 위에 나열한 의미 키를 `{ "kind": "semantic", "key": "userTurn" }` 형태로 쓴 것일 수 있습니다. 의미 키는 보통 더 안정적이지만, 현재 사이트 어댑터가 그 키를 선언해야 합니다.

선언형 작업은 되돌릴 수 있고 반복 실행해도 안전해야 합니다. 한 번뿐인 페이지 상태에 의존하지 말고, DOM이 항상 그대로라고 가정하지 마세요.

### 프리미티브

CSS와 되돌릴 수 있는 DOM 수정만으로는 표현할 수 없는 동작도 있습니다. 프리미티브는 Voyager 안에 함께 배포되는 자체 코드이며, manifest는 `native` 작업으로 이름을 적어 호출할 수 있습니다.

```json
{
  "engine": ">=1.3.0",
  "requires": { "handlers": ["formulaCopy"] },
  "contributes": {
    "domOps": [{ "op": "native", "handler": "formulaCopy", "params": {} }]
  }
}
```

manifest는 프리미티브를 고르고 설정할 뿐 로직을 담지 않습니다. `params`는 실행 전에 해당 프리미티브가 직접 검증합니다.

프리미티브를 쓰는 플러그인에는 두 가지 규칙이 있습니다.

- `requires.handlers`에 그 프리미티브를 적어야 합니다.
- `engine`은 그 프리미티브가 처음 들어간 엔진 버전 이상이어야 합니다. `formulaCopy`는 엔진 1.3.0에 들어갔으므로 이를 쓰는 플러그인은 `">=1.3.0"`으로 선언합니다. 범위가 더 낮으면 `bun run catalog:build`가 실패합니다. 예전 Voyager에서는 업데이트를 안내하는 대신 handler가 없다고 보고하기 때문입니다.

프리미티브는 늘어나기만 합니다. 새 매개변수는 항상 선택이고, 호환성을 깨는 변경은 새 이름으로 나갑니다.

동작이 바뀐 플러그인은 한 줄짜리 `changelog`도 넣을 수 있고, popup이 버전 옆에 보여줍니다. 번역은 `name`, `description`과 나란히 `i18n.<locale>.changelog`에 씁니다.

## 일반 플러그인에 적합하지 않은 경우

JavaScript 실행, 요청 가로채기, Voyager 내부 데이터 읽기/쓰기, 복잡한 런타임 로직이 필요한 기능은 일반 선언형 플러그인에 적합하지 않습니다.

이런 기능은 먼저 Issue를 열어 요구사항을 설명하세요. 내장 기능이 꼭 필요하다면 Formula Copy처럼 Voyager 메인 저장소의 builtin/native 플러그인으로 구현하는 것을 검토할 수 있습니다.

## PR 전 확인

- 플러그인은 기본적으로 꺼져 있고 사용자가 직접 켭니다.
- 거의 동일한 기존 플러그인이 없는지 확인했습니다. 있다면 기존 플러그인 개선을 우선했습니다.
- 대상 사이트의 라이트/다크 테마에서 테스트했습니다.
- `matches`가 관련 없는 사이트를 포함하지 않습니다.
- 원격 리소스 참조가 없습니다.
- 플러그인 디렉터리에 `plugin.json`, 필요한 CSS 파일, 짧은 README가 있습니다.
- 공식 플러그인이라면 디렉터리가 `catalog/sites/<site>/plugins/<id>/`에 있고, `matches`가 사이트의 `matches` 안에 있으며, `catalog/marketplace.json`에 등록되어 있습니다.
- PR 설명에 테스트 페이지, 스크린샷 또는 녹화, 영향을 받을 페이지 영역을 적었습니다.

단순하고 절제되며 되돌릴 수 있게 유지하세요. 하나의 분명한 문제를 해결하는 플러그인이 보통 더 쉽게 병합되고 유지보수됩니다.
