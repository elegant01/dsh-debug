/**
 * Best-effort redaction for values that pass through the debugger:
 * variable snapshots, evaluated expressions, process output.
 *
 * Debugging reads real process memory. Tokens and keys do show up in locals
 * (`cfg.ApiKey`, `os.Getenv("OPENAI_API_KEY")` evaluated on purpose, …).
 * Patterns here cover the common shapes; the goal is to never feed a known
 * secret shape into a model request, not to prove a negative.
 *
 * @module dsh-debug/lib/redact
 */

const PATTERNS = [
  // Cloud provider keys
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  // GitHub / GitLab tokens
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  // npm
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  // OpenAI-style keys (sk-*, including sk-proj)
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  // Anthropic
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  // Slack
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // JWT (header.payload.signature)
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // key=value / "key": "value" shapes for classic secret names
  /((?:password|passwd|secret|token|apikey|api_key|api-key|access_key|private_key|client_secret)["']?\s*[:=]\s*["'])([^"'\s]{6,})(["'])/gi,
]

/**
 * Redact known secret shapes inside a string.
 * @param {string} text
 * @returns {string}
 */
export function redactText(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (whole, ...groups) => {
      // The key=value pattern keeps the key and quotes, masks the value.
      if (groups.length >= 3 && groups[2] !== undefined && typeof groups[0] === 'string' && /[:=]\s*["']$/.test(groups[0])) {
        return `${groups[0]}•••${groups[2]}`
      }
      return '•••'
    })
  }
  return out
}

/**
 * Deep-redact a structured value (variables, evaluation results).
 * Object keys that look secret-shaped get masked wholesale.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redactValue(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, val] of Object.entries(value)) {
      if (/(password|passwd|secret|token|apikey|api_key|api-key|access_key|private_key|client_secret)/i.test(key)
          && typeof val === 'string' && val.length >= 6) {
        out[key] = '•••'
      } else {
        out[key] = redactValue(val, depth + 1)
      }
    }
    return out
  }
  return value
}
