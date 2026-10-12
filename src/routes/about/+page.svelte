<script lang="ts">
	import { resolve } from '$app/paths';
	import { REPO_URL, SITE_NAME } from '#lib/config.ts';
	import { ABOUT_TITLE } from '#lib/seo.ts';
	import { WIKI, WIKI_NAME, WIKI_PAGE } from '#lib/wiki.ts';

	const ISSUES = `${REPO_URL}/issues`;
</script>

<svelte:head>
	<title>{ABOUT_TITLE}</title>
</svelte:head>

{#snippet out(href: string, text: string)}
	<a {href} target="_blank" rel="noopener" class="text-accent hover:underline">{text}</a>
{/snippet}

<article class="mx-auto max-w-3xl space-y-4 leading-relaxed">
	<a href={resolve('/')} class="text-muted hover:text-accent">← All addons</a>
	<section class="panel p-4">
		<h1 class="text-3xl font-bold">About</h1>
		<p class="mt-3">
			{SITE_NAME} is a community list of addons for the 1.12.1 client of World of Warcraft. It
			links to where each addon lives; it hosts no addon files itself. Anyone can browse it, and
			anyone with an account can post an addon and edit or remove what they posted.
		</p>
		<p class="mt-3">
			It is a hobby project run by {@render out('https://github.com/akzkak', 'akzkak')}, free and
			without ads. The {@render out(REPO_URL, 'source is on GitHub')}. Part of the list was
			imported from the {@render out(`${WIKI}/wiki/${WIKI_PAGE}`, WIKI_NAME)}, whose text is
			licensed CC BY-SA; those entries say so on their page.
		</p>
		<p class="mt-3 text-muted">
			This site is not affiliated with or endorsed by Blizzard Entertainment or by any game
			server. World of Warcraft is a trademark of Blizzard Entertainment.
		</p>
	</section>

	<section class="panel p-4" id="privacy">
		<h2 class="section-title">Privacy</h2>
		<p class="mt-3">
			Browsing needs no account, and the site uses no analytics, no ads and no tracking cookies.
			What follows is everything it keeps.
		</p>

		<h3 class="field-label mt-5">If you only browse</h3>
		<ul class="list-disc space-y-1 pl-5">
			<li>
				Nothing about you is stored by the site. Your browser keeps a copy of the addon list so the
				next visit loads at once.
			</li>
			<li>
				The pages are served by GitHub Pages, and screenshots are loaded straight from wherever
				the poster hosts them. Like any web server, those see your IP address. The site tells
				screenshot hosts nothing about which page you came from.
			</li>
		</ul>

		<h3 class="field-label mt-5">If you log in</h3>
		<p>Logging in goes through GitHub or Discord. From then on these are stored:</p>
		<ul class="mt-1 list-disc space-y-1 pl-5">
			<li>
				<strong>Your email address</strong>, your id at GitHub or Discord, and the display name and
				picture link they send along. The login service requires the email. The site never shows
				it, not even to its admins, and never sends you email.
			</li>
			<li>
				<strong>A username</strong>, taken from the account you logged in with. Only you and the
				site's admins can see it; visitors cannot see who posted an addon.
			</li>
			<li>
				<strong>What you do:</strong> the addons you post and edit, reports and suggestions you
				send, and a log of those actions that admins use to undo mistakes and abuse.
			</li>
			<li>
				<strong>Your login session</strong>, with the IP address and browser it was started from,
				and a copy of it in your browser so you stay logged in.
			</li>
		</ul>

		<h3 class="field-label mt-5">Where it is kept, and for how long</h3>
		<ul class="list-disc space-y-1 pl-5">
			<li>
				Accounts and the list are stored with Supabase, in the EU (Ireland). GitHub hosts the
				pages and the code.
			</li>
			<li>A deleted addon stays in a trash that only admins can open for 90 days.</li>
			<li>
				The admins' log keeps what an addon looked like before each edit for 90 days. After that
				it only says who changed which fields, and when.
			</li>
			<li>
				A full backup is made every night, encrypted, and deleted after 90 days. Something removed
				from the site is gone from the backups 90 days later.
			</li>
			<li>Everything else is kept for as long as the account exists.</li>
		</ul>
		<p class="mt-3">None of it is sold, shared or used for anything but running this list.</p>

		<h3 class="field-label mt-5">Deleting your account</h3>
		<p>
			The <a href={resolve('/account')} class="text-accent hover:underline">account page</a> has a
			"Delete account" button. It removes your login, email address, username and sessions at
			once. The addons you posted stay in the list, belonging to nobody; delete the ones you
			want gone first. What you did stays in the admins' log without your name.
		</p>
		<p class="mt-3">
			If the account was banned, a fingerprint of the login it used is kept, so that the ban
			still holds if that login comes back. The fingerprint cannot be turned back into the login.
		</p>
		<p class="mt-3">
			If the account posted addons in its last day, the same kind of fingerprint is kept for one
			day, so that the daily posting limit still holds if that login comes back.
		</p>

		<h3 class="field-label mt-5">Seeing or correcting your data</h3>
		<p>
			You can edit and delete your own addons at any time. To get a copy of what is stored about
			you, or to have something corrected, {@render out(ISSUES, 'open an issue on GitHub')} and
			give the username shown on your account page. An issue is public, so put nothing else
			personal in it.
		</p>
	</section>

	<section class="panel p-4" id="contact">
		<h2 class="section-title">Contact</h2>
		<p class="mt-3">
			For questions, mistakes in the list or anything about this page,
			{@render out(ISSUES, 'open an issue on GitHub')}. To flag a single addon, use "Report this
			addon" on its page.
		</p>
	</section>
</article>
