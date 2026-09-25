/**
 * Base64 for radar PNGs. Uses the native Uint8Array.prototype.toBase64 when the runtime has it;
 * otherwise btoa over 8 KB chunks via fromCharCode.apply (about 10x faster than spreading the
 * array, which matters on the Free plan's 10 ms CPU budget: ~0.35 ms for six 20 KB frames).
 */
export function toBase64(bytes: Uint8Array): string {
	const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
	if (typeof native === "function") return native.call(bytes);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x2000) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000) as unknown as number[]);
	}
	return btoa(binary);
}
