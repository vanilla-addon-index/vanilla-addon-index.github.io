// The site's own "are you sure?" prompt, in place of the browser's.
// ask() shows it and resolves to true when the action is confirmed.

export interface Question {
	title: string;
	// A line or two under the title: what will happen.
	body?: string;
	// Label of the confirming button, for example "Delete".
	action: string;
	// Marks the confirming button as destructive.
	danger?: boolean;
}

export const prompt = $state({
	open: null as (Question & { answer: (confirmed: boolean) => void }) | null
});

export function ask(question: Question) {
	return new Promise<boolean>((answer) => {
		// A second prompt replaces the first, which counts as declined.
		prompt.open?.answer(false);
		prompt.open = { ...question, answer };
	});
}
