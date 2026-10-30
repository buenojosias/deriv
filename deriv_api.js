const API_BASE = "https://api.derivws.com";
const PUBLIC_WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";

function lastDigit(quote, pipSize) {
  const value = Number(quote);
  if (!Number.isFinite(value) || !Number.isInteger(pipSize) || pipSize < 0 || pipSize > 100) {
    throw new Error("Cotação ou pip_size inválido");
  }
  return Number(value.toFixed(pipSize).at(-1));
}

async function authenticatedWsUrl({ token, appId, accountId, fetchImpl = fetch }) {
  if (!token || !appId || !accountId) {
    throw new Error("Defina DERIV_API_TOKEN, DERIV_APP_ID e DERIV_ACCOUNT_ID");
  }
  const response = await fetchImpl(
    `${API_BASE}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Deriv-App-ID": String(appId),
      },
    }
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.errors?.[0]?.message || `Falha ao obter OTP: HTTP ${response.status}`);
  }
  const body = await response.json();
  const url = body.data?.url;
  let parsed;
  try { parsed = new URL(url); } catch (_) { /* invalid URL */ }
  if (!parsed || parsed.protocol !== "wss:" || parsed.hostname !== "api.derivws.com" ||
      !/^\/trading\/v1\/options\/ws\/(demo|real)$/.test(parsed.pathname) || !parsed.searchParams.get("otp")) {
    throw new Error("URL WebSocket autenticada inválida");
  }
  return url;
}

module.exports = { PUBLIC_WS_URL, lastDigit, authenticatedWsUrl };
