/** Customizable select pickers focus options during keyboard navigation before
 * committing them. Keep the bound category in sync with that visible choice. */
export function commitCategoryOnFocus(select: HTMLSelectElement) {
	let navigating = false;
	function keydown(event: KeyboardEvent) {
		navigating = !event.ctrlKey && !event.metaKey && !event.altKey &&
			(event.key.length === 1 || ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key));
	}
	function focused(event: FocusEvent) {
		const option = event.target;
		if (!navigating || !(option instanceof HTMLOptionElement) || option.disabled || option.hidden || select.disabled) return;
		if (select.value === option.value) return;
		select.value = option.value;
		select.dispatchEvent(new Event('change', { bubbles: true }));
	}
	function reset() { navigating = false; }
	select.addEventListener('keydown', keydown);
	select.addEventListener('keyup', reset);
	select.addEventListener('pointerdown', reset);
	select.addEventListener('focusin', focused);
	return { destroy() {
		select.removeEventListener('keydown', keydown);
		select.removeEventListener('keyup', reset);
		select.removeEventListener('pointerdown', reset);
		select.removeEventListener('focusin', focused);
	} };
}
