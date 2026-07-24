/**
 * Plain-English predicate parser (rule-based, no LLM).
 *
 * Ported from Sluice (Casper)'s offline parser. Takes a natural-language
 * description and returns a JSON predicate ready for the matcher engine.
 *
 * Examples:
 *   "whales over 100k TSLA"         → Transfer ≥ 100000, TSLA token
 *   "transfers under 10 AAPL"       → Transfer ≤ 10, AAPL token
 *   "to 0xabc... over 5000"         → Transfer to address ≥ 5000
 *   "from 0xdef... any amount"      → Transfer from address
 *   "swap over 50000"               → Swap event, amount ≥ 50000
 *   "liquidation from 0xpool"       → Liquidation event from address
 *   "any event from 0xabc"          → Any event from address
 */
// ── token registry (matches ticker names to RHC addresses) ──────────────────
// This mirrors tokens.ts but as a quick lookup for the parser.
const TOKEN_TICKERS = {
    tsla: { address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", name: "TSLA" },
    aapl: { address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", name: "AAPL" },
    nvda: { address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", name: "NVDA" },
    amzn: { address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", name: "AMZN" },
    msft: { address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", name: "MSFT" },
    googl: { address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", name: "GOOGL" },
    meta: { address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", name: "META" },
    mstr: { address: "0xec262a75e413fAfD0dF80480274532C79D42da09", name: "MSTR" },
    spy: { address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", name: "SPY" },
    qcom: { address: "0x0f17206447090e464C277571124dD2688E48AEA9", name: "QCOM" },
};
// ── number parsing ──────────────────────────────────────────────────────────
const SUFFIXES = {
    k: 1_000, m: 1_000_000, b: 1_000_000_000,
    thousand: 1_000, million: 1_000_000, billion: 1_000_000_000,
};
function parseNumberPhrase(raw) {
    const s = raw.toLowerCase().replace(/_/g, "").replace(/,/g, "").trim();
    // "100k" / "2.5m" / "1b"
    for (const [suffix, mult] of Object.entries(SUFFIXES)) {
        const re = new RegExp(`^([\\d.]+)\\s*${suffix}$`);
        const m = re.exec(s);
        if (m)
            return parseFloat(m[1]) * mult;
    }
    // plain number
    const n = Number(s);
    return Number.isNaN(n) ? null : n;
}
/** Convert a human-readable amount (like 100000) into a wei-like string if it looks like tokens.
 *  For tokenized equities, we assume the raw number * 10^18 (ERC-20 decimals). */
function toWeiLike(n) {
    const rounded = Math.round(n);
    return String(BigInt(rounded) * BigInt(10 ** 18));
}
// ── address detection ───────────────────────────────────────────────────────
const ADDRESS_RE = /0x[a-fA-F0-9]{40}/;
const ADDRESS_SHORT = /0x[a-fA-F0-9]{6,}/;
function findAddress(text) {
    const m = ADDRESS_RE.exec(text);
    return m ? m[0].toLowerCase() : null;
}
function findTicker(text) {
    const lower = text.toLowerCase();
    for (const [ticker, info] of Object.entries(TOKEN_TICKERS)) {
        if (lower.includes(ticker))
            return info;
    }
    return null;
}
// ── event type detection ────────────────────────────────────────────────────
const EVENT_PATTERNS = [
    { pattern: /\bswap\b/, eventName: "Swap" },
    { pattern: /\bliquidation\b/, eventName: "Liquidation" },
    { pattern: /\bdeposit\b/, eventName: "Deposit" },
    { pattern: /\bwithdraw(al)?\b/, eventName: "Withdrawal" },
    { pattern: /\bmint\b/, eventName: "Mint" },
    { pattern: /\bburn\b/, eventName: "Burn" },
    { pattern: /\btransfer\b/, eventName: "Transfer" },
    { pattern: /\bwhales?\b/, eventName: "Transfer" }, // "whales" defaults to Transfer
];
function detectEvent(text) {
    const lower = text.toLowerCase();
    for (const { pattern, eventName } of EVENT_PATTERNS) {
        if (pattern.test(lower))
            return { eventName, isDefault: eventName === "Transfer" && !lower.includes("transfer") };
    }
    return { eventName: "Transfer", isDefault: true };
}
export class ParseError extends Error {
}
/**
 * Parse a plain-English description into a JSON predicate.
 *
 * Handles these patterns (order matters — more specific first):
 *   1. "whales over 100k TSLA"       → Transfer, value ≥ threshold
 *   2. "transfers under 10 AAPL"     → Transfer, value ≤ threshold
 *   3. "to 0xABC over 5000"          → Transfer to address, value ≥
 *   4. "from 0xABC"                  → Transfer from address
 *   5. "swap over 50000"             → Custom event, amount ≥
 *   6. "liquidation from 0xpool"     → Custom event from address
 *   7. "any event from 0xABC"        → Any event from
 */
export function parse(input) {
    const raw = input.trim();
    if (!raw)
        throw new ParseError("Empty input. Try: \"whales over 100k TSLA\"");
    const lower = raw.toLowerCase();
    // ── extract components ──
    const address = findAddress(raw);
    const ticker = findTicker(raw);
    const { eventName } = detectEvent(raw);
    // ── detect comparison direction ──
    let op = null;
    let amount = null;
    const overMatch = /(over|above|more than|bigger than|greater than|≥|>=)\s*([\d.]+[kmb]?)/i.exec(raw);
    const underMatch = /(under|below|less than|smaller than|≤|<=)\s*([\d.]+[kmb]?)/i.exec(raw);
    const exactlyMatch = /(exactly|precisely|==?|=)\s*([\d.]+[kmb]?)/i.exec(raw);
    if (overMatch) {
        op = "gte";
        amount = parseNumberPhrase(overMatch[2]);
    }
    else if (underMatch) {
        op = "lte";
        amount = parseNumberPhrase(underMatch[2]);
    }
    else if (exactlyMatch) {
        op = "eq";
        amount = parseNumberPhrase(exactlyMatch[2]);
    }
    // detect "any amount" or "any" → no value filter
    const anyAmount = /\bany\b/.test(lower);
    // ── build conditions ──
    const conditions = [];
    // event type condition (for non-Transfer events)
    if (eventName !== "Transfer") {
        conditions.push({ field: "eventName", op: "eq", value: eventName });
    }
    // always add Transfer eventName unless explicitly another event
    if (eventName === "Transfer") {
        conditions.push({ field: "eventName", op: "eq", value: "Transfer" });
    }
    // token filter
    if (ticker) {
        conditions.push({ field: "address", op: "eq", value: ticker.address });
    }
    // direction detection
    const fromMatch = /\b(from|out of|sender)\b\s*(0x[a-fA-F0-9]{6,})?/i.exec(raw);
    const toMatch = /\b(to|into|recipient|receiver)\b\s*(0x[a-fA-F0-9]{6,})?/i.exec(raw);
    // explicit direction + address
    if (fromMatch && address) {
        conditions.push({ field: "from", op: "eq", value: address });
    }
    else if (toMatch && address) {
        conditions.push({ field: "to", op: "eq", value: address });
    }
    else if (address && !fromMatch && !toMatch) {
        // bare address — treat as "to" for Transfer, "from" for events like Liquidation
        if (eventName === "Transfer") {
            // Could be either; check phrase context. "to 0x" is explicit, bare address defaults to "to"
            if (lower.includes(" to ") || lower.startsWith("to ")) {
                conditions.push({ field: "to", op: "eq", value: address });
            }
            else if (lower.includes(" from ") || lower.startsWith("from ")) {
                conditions.push({ field: "from", op: "eq", value: address });
            }
            else {
                // default: treat bare address as "from" for non-Transfer, "to" for Transfer
                conditions.push({ field: "to", op: "eq", value: address });
            }
        }
        else {
            conditions.push({ field: "from", op: "eq", value: address });
        }
    }
    // amount filter
    if (op && amount !== null) {
        conditions.push({ field: "value", op: op, value: toWeiLike(amount) });
    }
    else if (!anyAmount && !op && amount !== null) {
        // bare number — default to >=
        conditions.push({ field: "value", op: "gte", value: toWeiLike(amount) });
    }
    // ── build result ──
    const predicate = conditions.length === 1
        ? conditions[0]
        : { and: conditions };
    // ── human-readable description ──
    const tokenName = ticker ? ticker.name : (address ? address.slice(0, 10) + "…" : "any token");
    const dest = fromMatch ? "from" : (toMatch ? "to" : (address ? "involving" : ""));
    const amountDesc = op && amount
        ? `≥ ${amount.toLocaleString()} ${tokenName}`
        : (anyAmount ? "any amount" : (amount ? `≈ ${amount.toLocaleString()} ${tokenName}` : ""));
    const parts = [`Watching ${eventName} events`];
    if (dest && address)
        parts.push(`${dest} ${address.slice(0, 10)}…`);
    if (amountDesc)
        parts.push(amountDesc);
    if (ticker && !amountDesc)
        parts.push(`on ${tokenName}`);
    // ── suggestions ──
    const suggestions = [
        `whales over 100k TSLA`,
        `transfers under 10 AAPL`,
        `to ${address || "0xYourAddress"} over 5000`,
        `swap over 50000`,
        `liquidation from ${address || "0xPoolAddress"}`,
    ];
    return { predicate, description: parts.join(" · "), suggestions };
}
