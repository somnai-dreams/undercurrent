// Give each outer transport time to return the inner handoff's actual result.
export const nativeTimeoutMs = 10_000
export const relayReceiptTimeoutMs = nativeTimeoutMs + 2_000
export const remoteRequestTimeoutMs = relayReceiptTimeoutMs + 3_000
