// public/lib/vault.js
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

export function makeVaultHelpers(app, region = "us-east4") {
  const functions = getFunctions(app, region);

  // Tolerant parser for callable results
  function parseCallable(resp) {
    // Callable always returns an object with a `data` property, but be flexible.
    const data = (resp && resp.data) ? resp.data : resp;
    return data || {};
  }

  /**
   * Save to the Vault via callable `vaultSave`.
   * Accepts either:
   *   resp.data = { ok:true, id, ... }
   * or (for future-proofing)
   *   resp = { ok:true, id, ... }
   */
  async function saveToVault(entry) {
    try {
      const call = httpsCallable(functions, "vaultSave");
      const resp = await call(entry);
      const data = parseCallable(resp);

      if (data && data.ok) {
        // Normalize a friendly return
        return {
          ok: true,
          id: data.id ?? data.data?.id ?? null,
          echo: data.echo ?? null,
          raw: data,
        };
      }

      // If backend included a message, surface it
      const msg = data?.error || data?.message || "Vault save failed";
      throw new Error(msg);
    } catch (err) {
      console.error("[vault] saveToVault error:", err);
      // Re-throw a clean message up to callers
      throw new Error(err?.message || "Vault save failed");
    }
  }

  /**
   * Optional list helper. Keep tolerant too.
   * (If you haven’t implemented this callable yet, you can stub it out.)
   */
  async function listEpisodes(opts = {}) {
    try {
      const call = httpsCallable(functions, "vaultListEpisodes");
      const resp = await call(opts);
      const data = parseCallable(resp);
      if (Array.isArray(data?.episodes)) return data.episodes;
      return [];
    } catch (err) {
      console.warn("[vault] listEpisodes error:", err?.message || err);
      return [];
    }
  }

  return { saveToVault, listEpisodes };
}