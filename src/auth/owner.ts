/** OWNER_EMAIL is a comma-separated allow-list; comparison is case-insensitive. */
export function parseOwners(value: string | undefined): Set<string> {
	return new Set(
		(value ?? "")
			.split(",")
			.map((e) => e.trim().toLowerCase())
			.filter(Boolean),
	);
}

/** False when no owner is configured: an empty allow-list never means "everyone". */
export function isOwner(email: unknown, ownerEmail: string | undefined): boolean {
	if (typeof email !== "string" || email.trim() === "") return false;
	const owners = parseOwners(ownerEmail);
	return owners.size > 0 && owners.has(email.trim().toLowerCase());
}
