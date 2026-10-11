export interface Version {
	url: string;
	note: string;
	// Set when an admin merged this version in from another user's entry.
	added_by?: string;
}

export interface Addon {
	id: number;
	slug: string;
	name: string;
	description: string;
	category: string;
	author: string;
	// Versions (forks) of one addon share a group; one of them is its main version.
	group_id: number | null;
	is_main: boolean;
	// Where to get it: the main link first, then mirrors of the same code elsewhere.
	versions: Version[];
	// The main link: the first version's address, derived by the database.
	repo_url: string;
	// Where the entry was imported from, empty when a user posted it.
	source: string;
	// Addresses of addons merged into this one.
	aliases: string[];
	images: string[];
	owner: string;
	owner_name: string;
	created_at: string;
	updated_at: string;
}

export type AddonInput = Pick<
	Addon,
	| 'name'
	| 'description'
	| 'category'
	| 'author'
	| 'versions'
	| 'images'
>;
