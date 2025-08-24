# PatientLead+ Platform Contracts (v1)

This doc locks the APIs that tools depend on so UIs can be rebuilt safely.

---

## 1) Frontend helper library

**File:** `/public/lib/briefmeSave.js`  
**Must export:**
- `initAuth(): Promise<void>`
- `saveEntryToVault(params): Promise<{ id: string }>`
- `saveEntryToVaultWithHooks(params, hooks): Promise<{ id: string }>`
- `setGlobalHandoff(obj): void`
- `getGlobalHandoff(clear?: boolean): object|null`
- `registerToolHandoff(toolName, targetUrl, mapFn): () => void`
- `registerCopilotIngest(opts): { beforeSave, afterSave }`

**Auto-init (loaded site-wide):** `/public/lib/briefmeAuto.js`
- Provides `window.briefme.configureForm(config)`  
- Auto-registers CoPilot with a default tool label derived from URL

---

## 2) Vault Save contract

### `saveEntryToVault(params)` (frontend)

**Params**
```ts
{
  type: string;          // canonical tool key (see section 4)
  title: string;         // human-readable title for Vault list
  structured: object;    // full payload for the entry
  rawOverride?: string;  // optional text if not using JSON of structured
  extraTags?: string[];  // optional tags; "briefme" and type are auto-added
}