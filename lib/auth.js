// Clerk session verification with Web Crypto: RS256 JWT checked against the instance JWKS.
// The publishable key encodes the Frontend API host (base64 of "<host>$"), which is the token issuer.

export function clerkFrontendApi(publishableKey) {
  const b64 = String(publishableKey || "").replace(/^pk_(test|live)_/, "");
  if (!b64) return "";
  return atob(b64).replace(/\$$/, "");
}

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

export function createVerifier({ publishableKey, authorizedParties = [] }) {
  const issuer = "https://" + clerkFrontendApi(publishableKey);
  let keys = null, keysAt = 0;

  async function key(kid) {
    if (!keys || !keys[kid] && Date.now() - keysAt > 60_000) {
      const jwks = await (await fetch(issuer + "/.well-known/jwks.json")).json();
      keys = {};
      for (const k of jwks.keys || []) keys[k.kid] = await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      keysAt = Date.now();
    }
    return keys[kid];
  }

  // Returns { uid, org, plan } for a valid token (plan is the Clerk Billing plan slug from the `pla`
  // claim, e.g. "u:pro" → "pro"), or null when the token is missing or invalid.
  return async function verify(token) {
    const [h, p, s] = String(token || "").split(".");
    if (!s) return null;
    try {
      const header = JSON.parse(new TextDecoder().decode(b64url(h)));
      const claims = JSON.parse(new TextDecoder().decode(b64url(p)));
      const k = header.alg === "RS256" && (await key(header.kid));
      if (!k || !(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", k, b64url(s), new TextEncoder().encode(`${h}.${p}`)))) return null;
      const now = Date.now() / 1000;
      if (claims.iss !== issuer || claims.exp < now - 5 || (claims.nbf && claims.nbf > now + 5)) return null;
      if (claims.azp && authorizedParties.length && !authorizedParties.includes(claims.azp)) return null;
      // `o` (session token v2) is the active organization: { id, rol, slg }.
      return claims.sub ? { uid: claims.sub, org: claims.o?.id || "", plan: String(claims.pla || "").replace(/^[uo]:/, "") } : null;
    } catch { return null; }
  };
}

export function sessionToken(req) {
  const auth = req.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)__session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}
