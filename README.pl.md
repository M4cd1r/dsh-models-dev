# dsh-models-dev

**Żywy katalog [models.dev](https://models.dev) dla providerów LLM w DeepSeek Harness.**

`dsh-llm-pi-ai` rozwiązuje providerów i modele względem **wbudowanego** katalogu pi-ai — migawki models.dev z momentu budowania, która starzeje się między wydaniami. Gdy OpenCode Go dodał `mimo-v2.6-pro` (22.09.2026), każdy zainstalowany katalog pi-ai go nie miał, a dsh odmawiał trasy: *„provider "opencode-go" model "mimo-v2.6-pro" needs an api; the installed catalog does not describe it"*.

Ten plugin zastępuje ten mechanizm dla tras, które obsługuje: pobiera `https://models.dev/api.json` przy starcie i co `refreshHours`, mapuje modele skonfigurowanych providerów na wpisy modeli pi-ai (protokół, endpoint, ceny, limity, modalności) i rejestruje trasy przez ten sam seam `ctx.llm`, którego używa `llm-pi-ai`. Nowe modele z models.dev pojawiają się bez czekania na wydanie pi-ai.

## Instalacja

```
dsh plugin --profile web add dsh-models-dev
```

Potem zrestartuj dsh (plugin montuje się przez bundle patch profilu).

## Konfiguracja

Sekcja `dsh-models-dev` w `~/.dsh/settings.yaml`:

```yaml
dsh-models-dev:
  refreshHours: 24          # odświeżanie katalogu (opcjonalne)
  providers:
    opencode-go:            # klucz trasy w dsh — TO on decyduje o współistnieniu/zastąpieniu
      source: opencode-go   # id providera na models.dev (domyślnie = klucz trasy)
      apiKeyEnv: OPENCODE_GO_API_KEY
```

To wystarczy: każdy model z tool_call i nie-deprecated z models.dev dla `opencode-go` staje się wybieralnym modelem dsh.

**Tryb zastąpienia** — użyj klucza, który serwuje llm-pi-ai (`opencode-go`), ale najpierw *usuń* tę trasę z `llm-pi-ai.providers`; klucz trasy może być zarejestrowany tylko przez jeden adapter.

**Tryb współistnienia** — wybierz klucz nieużywany przez llm-pi-ai:

```yaml
dsh-models-dev:
  providers:
    opencode-go-live:
      source: opencode-go
      apiKeyEnv: OPENCODE_GO_API_KEY
      models:                       # opcjonalnie: podzbiór / nadpisania pól
        - id: mimo-v2.6-pro
          name: MiMo V2.6 Pro
          maxTokens: 131072         # jawny maxTokens staje się też domyślnym limitem żądania
```

Pola trasy: `source`, `displayName`, `apiKeyEnv`, `baseURL`, `api` (wymusza jeden protokół dla wszystkich modeli), `defaultContextWindow`, `defaultMaxTokens`, `models` (id + opcjonalne nadpisania `name`/`contextWindow`/`maxTokens`/`input`/`reasoning`; gdy jest podana, serwowane są tylko wymienione id).

## Jak to działa

1. **Pobranie** — `models.dev/api.json` przy starcie i co `refreshHours`, cache w `$DSH_HOME/plugins/dsh-models-dev/models.dev.json`; przy braku sieci serwowana jest ostatnia migawka (ze stosownym ostrzeżeniem).
2. **Mapowanie** — czyste mapowanie (`lib/map.mjs`) według reguł z pi-ai `generate-models.ts`: `provider.npm` (nadpisywalne per model) wybiera protokół (`@ai-sdk/anthropic` → `anthropic-messages`, `@ai-sdk/openai` → `openai-responses`, reszta → `openai-completions`); `provider.api` to bazowy URL (dla Anthropic przycinany do kształtu z `/v1/messages` dopisywanym przez SDK); ceny/limity/modalności 1:1; przeplatany `reasoning_content` oznacza kompatybilność replay. Przełączniki compat, które pi-ai wykrywa z id providera + baseURL, zostają puste — decyduje jego własna detekcja.
3. **Rejestracja** — jeden `PiAiAdapter` (z `@deepseek-ai/dsh-llm-pi-ai`) serwuje wszystkie trasy przez `ctx.llm.registerAdapter`, plus `registerConfigurableProviders` (UI ustawień) i `registerModelDiscovery` („pobierz modele" oparte na models.dev). Klasy hosta są rozwiązywane z instancji modułów działającego dsh, więc seam widzi zgodną tożsamość klas.

## Ograniczenia (0.1.0)

- `thinkingLevelMap` / poziomy `reasoning_options` nie są jeszcze mapowane (tylko `reasoning: true|false`).
- Modele `google-generative-ai` są zgłaszane jako nieużyteczne (wypisane, nie do wysyłki).
- Modele bez `tool_call: true` oraz ze statusem `deprecated` są pomijane (agent kodujący ich nie użyje).

## Rozwój

```
npm run verify   # kontrola składni + testy jednostkowe + smoke (żywy models.dev best-effort)
```

## Licencja

MIT
