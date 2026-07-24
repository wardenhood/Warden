/**
 * Predicate engine — enhanced for Warden Pro.
 *
 * Chain-agnostic JSON predicate language with dot.notation field paths,
 * 12 comparison ops, nested and/or, and match-reason tracking for
 * click-to-explain. Ported from Sluice (Casper) + extended.
 *
 * Regex safety: Layer 1 = static heuristic (isRegexSafe), Layer 2 = worker pool (safe-regex.ts).
 */
import { execRegex } from "./safe-regex.js";
const MAX_DEPTH = 6;
const MAX_CONDITIONS = 32;
const MAX_REGEX_LENGTH = 200;
const MAX_REGEX_REPETITIONS = 8;
const ALL_OPS = new Set([
    "eq", "neq", "gte", "lte", "gt", "lt",
    "in", "not_in", "contains", "starts_with", "ends_with", "regex",
]);
export class PredicateError extends Error {
}
// ── regex-safety scanner (Layer 1) ──────────────────────────────────────────
const REDOS_NESTED_RE = /\([^)]*?[\*\+][^)]*?\)[\*\+]|\([^)]*?[\*\+][^)]*?\)\{/;
const REDOS_ALTERNATION_RE = /\(([^)]+\|){8,}[^)]*\)[\*\+]/;
function isRegexSafe(pattern) {
    if (pattern.length > MAX_REGEX_LENGTH)
        return false;
    if (REDOS_NESTED_RE.test(pattern))
        return false;
    if (REDOS_ALTERNATION_RE.test(pattern))
        return false;
    let repCount = 0;
    let i = 0;
    while (i < pattern.length) {
        if (pattern[i] === "\\") {
            i += 2;
            continue;
        }
        if (pattern[i] === "[") {
            while (i < pattern.length && pattern[i] !== "]")
                i++;
            i++;
            continue;
        }
        if ("*+?".includes(pattern[i]) || (pattern[i] === "{" && pattern.includes("}", i))) {
            repCount++;
            if (repCount > MAX_REGEX_REPETITIONS)
                return false;
            if (pattern[i] === "{") {
                while (i < pattern.length && pattern[i] !== "}")
                    i++;
            }
        }
        i++;
    }
    return true;
}
// ── validation ──────────────────────────────────────────────────────────────
export function validatePredicate(p, depth = 0, count = { n: 0 }) {
    if (depth > MAX_DEPTH)
        throw new PredicateError(`predicate nesting exceeds ${MAX_DEPTH}`);
    if ("and" in p) {
        if (!Array.isArray(p.and) || p.and.length === 0)
            throw new PredicateError("and[] must be non-empty");
        for (const child of p.and)
            validatePredicate(child, depth + 1, count);
    }
    else if ("or" in p) {
        if (!Array.isArray(p.or) || p.or.length === 0)
            throw new PredicateError("or[] must be non-empty");
        for (const child of p.or)
            validatePredicate(child, depth + 1, count);
    }
    else if ("field" in p) {
        count.n++;
        if (count.n > MAX_CONDITIONS)
            throw new PredicateError(`predicate exceeds ${MAX_CONDITIONS} conditions`);
        if (typeof p.field !== "string" || p.field.length === 0)
            throw new PredicateError("condition.field required");
        if (!ALL_OPS.has(p.op))
            throw new PredicateError(`unsupported op: ${p.op}`);
        if (p.op === "regex" && typeof p.value === "string" && !isRegexSafe(p.value)) {
            throw new PredicateError("regex pattern looks unsafe (pattern rejected by Layer 1 heuristic)");
        }
        if (["contains", "starts_with", "ends_with"].includes(p.op) && typeof p.value !== "string") {
            throw new PredicateError(`${p.op} requires a string value`);
        }
        if (["in", "not_in"].includes(p.op)) {
            if (!Array.isArray(p.value) || p.value.length === 0) {
                throw new PredicateError(`${p.op} requires a non-empty array value`);
            }
        }
    }
    else {
        throw new PredicateError("predicate must be {and:[]}, {or:[]}, or a condition");
    }
}
// ── helpers ─────────────────────────────────────────────────────────────────
function resolveField(obj, path) {
    return path.split(".").reduce((acc, key) => {
        if (acc === undefined || acc === null)
            return undefined;
        return acc[key];
    }, obj);
}
function compareNumeric(a, b) {
    const ba = typeof a === "bigint" ? a : BigInt(a);
    const bb = typeof b === "bigint" ? b : BigInt(b);
    if (ba < bb)
        return -1;
    if (ba > bb)
        return 1;
    return 0;
}
function isNumericLike(v) {
    if (typeof v === "bigint" || typeof v === "number")
        return true;
    if (typeof v === "string")
        return /^-?\d+$/.test(v.trim());
    return false;
}
// ── condition evaluator (async — regex uses worker pool) ────────────────────
async function evalCondition(event, c) {
    const raw = resolveField(event, c.field);
    const actual = raw === undefined || raw === null ? "undefined" : String(raw);
    if (raw === undefined)
        return { matched: false, actual };
    switch (c.op) {
        case "eq":
            return {
                matched: isNumericLike(raw) && isNumericLike(c.value)
                    ? compareNumeric(raw, c.value) === 0
                    : actual.toLowerCase() === String(c.value).toLowerCase(),
                actual,
            };
        case "neq":
            return {
                matched: isNumericLike(raw) && isNumericLike(c.value)
                    ? compareNumeric(raw, c.value) !== 0
                    : actual.toLowerCase() !== String(c.value).toLowerCase(),
                actual,
            };
        case "gte": {
            if (!isNumericLike(raw) || !isNumericLike(c.value))
                return { matched: false, actual };
            return { matched: compareNumeric(raw, c.value) >= 0, actual };
        }
        case "lte": {
            if (!isNumericLike(raw) || !isNumericLike(c.value))
                return { matched: false, actual };
            return { matched: compareNumeric(raw, c.value) <= 0, actual };
        }
        case "gt": {
            if (!isNumericLike(raw) || !isNumericLike(c.value))
                return { matched: false, actual };
            return { matched: compareNumeric(raw, c.value) > 0, actual };
        }
        case "lt": {
            if (!isNumericLike(raw) || !isNumericLike(c.value))
                return { matched: false, actual };
            return { matched: compareNumeric(raw, c.value) < 0, actual };
        }
        case "in": {
            const list = Array.isArray(c.value) ? c.value : [c.value];
            return { matched: list.some((v) => String(v).toLowerCase() === actual.toLowerCase()), actual };
        }
        case "not_in": {
            const list = Array.isArray(c.value) ? c.value : [c.value];
            return { matched: !list.some((v) => String(v).toLowerCase() === actual.toLowerCase()), actual };
        }
        case "contains":
            return { matched: actual.toLowerCase().includes(String(c.value).toLowerCase()), actual };
        case "starts_with":
            return { matched: actual.toLowerCase().startsWith(String(c.value).toLowerCase()), actual };
        case "ends_with":
            return { matched: actual.toLowerCase().endsWith(String(c.value).toLowerCase()), actual };
        // ── regex: Layer 2 defense — worker pool with hard timeout ──
        case "regex": {
            try {
                const matched = await execRegex(String(c.value), actual);
                return { matched, actual };
            }
            catch {
                return { matched: false, actual };
            }
        }
        default:
            return { matched: false, actual };
    }
}
// ── tree evaluator (async, short-circuit semantics preserved) ───────────────
export async function evaluate(event, p) {
    return (await evaluateWithTrace(event, p)).matched;
}
export async function evaluateWithTrace(event, p) {
    const trace = [];
    const matched = await _eval(event, p, trace);
    return { matched, trace };
}
async function _eval(event, p, trace) {
    // AND — short-circuit: stop at first false
    if ("and" in p) {
        for (const child of p.and) {
            if (!(await _eval(event, child, trace)))
                return false;
        }
        return true;
    }
    // OR — short-circuit: stop at first true
    if ("or" in p) {
        for (const child of p.or) {
            if (await _eval(event, child, trace))
                return true;
        }
        return false;
    }
    const c = p;
    const { matched, actual } = await evalCondition(event, c);
    trace.push({
        field: c.field,
        op: c.op,
        expected: Array.isArray(c.value) ? c.value.join(", ") : String(c.value),
        actual,
        matched,
    });
    return matched;
}
