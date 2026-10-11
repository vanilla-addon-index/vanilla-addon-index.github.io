export interface Version {
	url: string;
	note: string;
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
	// Who posted it. An import belongs to nobody: only admins can change it.
	owner: string | null;
	owner_name: string;
	// The admin who approved it, for an import.
	approved_by: string | null;
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
