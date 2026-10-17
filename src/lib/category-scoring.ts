import { CATEGORIES, DEFAULT_CATEGORY } from './config.ts';

type Category = (typeof CATEGORIES)[number];
const CATEGORY_RULES: [Category, RegExp][] = [
	['Libraries', /\b[Ll]ib[A-Z]\w+/],
	['Libraries', /\b(library|libraries|ace2|ace ?addon|embedded)\b/i],
	['Loot Distribution', /\b(?:dkp|ep[\s/-]?gp|effort points?|gear points?)\b/i],
	['Roleplay', /\b(?:role[ -]?play(?:ing)?|rp)\b/i],
	['Boss Mods', /\b(boss ?mods?|boss(es)?\b|bigwigs|dbm|deadly boss|encounters?\b|raid warnings?\b|loatheb|c'?thun|nefarian|four horsemen|4hm)/i],
	// Character/inspect panels are interface addons even when they list gear or spells.
	['UI & Appearance', /\b(character|inspect(?:ion)?)(?:\s+stats?)?\s+(panels?|panes?|windows?|screens?|frames?)\b/i],
	['Unit Frames', /\b(unit ?frames?|unitframes|raid ?frames?|party ?frames?|target ?frames?|player ?frames?|focus ?frames?|pet ?frames?|name ?plates?|plates|portraits?|health ?bars?)\b/i],
	// Dedicated macro utilities can mention icons, buttons or tooltips as their UI.
	['Macros', /\b(macro(?:text)?[ -]+(helpers?|editors?|debug(?:gers?|ging)?|managers?|systems?|conditions?|functionality|icon|text|tooltips?)|(?:debug(?:ging)?|edit(?:ing)?|creat(?:e|ing))\s+(?:your\s+)?macros?)\b/i],
	['Macros', /\btooltips? for (?:your )?macros?\b/i],
	['Action Bars', /\b(action ?bars?|action ?buttons?|bar mod|bongos|keybind(s|ings?)?|bindings?|buttons?)\b/i],
	['Bags & Inventory', /\b(bags?|inventory|bank|containers?|sort(s|ing)? (your )?items?|equipment|outfits?|outfitter|trinkets?|durability)\b/i],
	['Auction & Economy', /\b(auctions?|auctioneer|auctionator|ah|vendors?|vending|merchants?|gold|money|cash|prices?|sell(s|er)?|buy(s|ing)?|market|mail(box|s)?)\b/i],
	['Map & Minimap', /\b(mini-?maps?|world ?maps?|maps?|coordinates?|waypoints?|compass|flight|gather(er|ing)? nodes?)\b/i],
	['Quests & Leveling', /\b(quests?|questing|questie|leveling|level(s|ed)? ?up|xp|exp|experience|reputation|guides?|attune(ment)?s?|achievements?)\b/i],
	['Buffs & Debuffs', /\b(buffs?|debuffs?|auras?|dots?|hots?|crowd control|absor(b|ption)s?)\b/i],
	['Chat & Social', /\b(chat|chan(nel)?s?|whispers?|messenger|guild|friends?|social|emotes?|invites?|ignore|anti-?spam|spammers|goldspam|lfm|lfg|bulletin|translat(e|ion|or))\b/i],
	['Tooltip', /\b(game ?)?tool-?tips?\b/i],
	['Professions', /\b(professions?|trade ?skills?|craft(s|ing)?|recipes?|fishing|herbs?|herbalism|minerals?|mining|enchanting|disenchant(s|ing)?|alchemy|cooking)\b/i],
	['PvP', /\b(pvp|battlegrounds?|battlefield|bgs?|av|ab|wsg|alterac valley|arathi basin|warsong gulch|arena|honor|flags?|enemy players?)\b/i],
	['Class', /\b(warriors?|paladins?|pally|hunters?|rogues?|priests?|shamans?|mages?|warlocks?|druids?|feral|totems?|pets?|stance|shapeshift(ed|ing)?|shift|talents?|brainwash(er|ing)?|poisons?|shards?|soulstones?|curses?|librams?|combo points?|feign)\b/i],
	['Raid & Party', /\b(raids?|raider|party|loot(ing)?|rolls?|groups?|assignments?|ready check|heal(s|er|ers|ing)?|tanks?)\b/i],
	['Combat', /\b(combat|damage|dps|threat|aggro|cast(s|ing)? ?bars?|cast(s|ing)?|spells?|swing ?timers?|cooldowns?|meter|crit|attack|interrupts?|procs?|rage|energy|mana|kills?|taunts?)\b/i],
	// General vocabulary remains evidence, alongside the stronger purpose rules below.
	['Macros', /\bmacros?\b/i],
	['UI & Appearance', /\b(full (ui|interface)|ui (replacement|overhaul|compilation|pack)|replacement for the original|complete (vanilla )?ui|comprehensive ui|interface suite|collection of interface)\b/i],
	['UI & Appearance', /\b(ui|skins?|themes?|textures?|diablo[ -]*(?:like[ -]*)?orbs?|decorative|decorations?)\b/i],
	// ElvUI, pfUI, SpartanUI: a name that ends in a capital "UI".
	['UI & Appearance', /[a-zI]UI\b/]
];

export type CategoryConfidence = 'Strong match' | 'Possible match' | 'Uncertain';
export interface CategoryEvidence {
	source: 'Name' | 'Description';
	text: string;
	weight: number;
}
export interface CategoryMatch {
	category: Category;
	score: number;
	evidence: CategoryEvidence[];
}
export interface CategorySuggestion {
	category: Category;
	confidence: CategoryConfidence;
	matches: CategoryMatch[];
}

const apart = (name: string) => name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
	.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/[_-]+/g, ' ');

// Specific purposes are stronger evidence than broad feature vocabulary.
const PURPOSES: [Category, RegExp, number?][] = [
	// Dedicated RP tools, not general emotes, player notes or immersive quest panels.
	['Roleplay', /^(?:TurtleRP|Erea-RP|RoleplayingHelper|Journal)$/i, 14],
	['Roleplay', /\b(?:role[ -]?play(?:ing)?|rp)\s+(?:addons?|players?|items?|profiles?|characters?|events?|tools?)\b/i, 24],
	// Audited allocation tools include companion displays and standby EP management.
	// Do not infer this category from "loot" alone: loot browsers and notifications differ.
	['Loot Distribution', /^(?:DKPList|DKPAuctionBidder|WebDKPElysium|DPEPGP|EZ-EPGP|EPGPexport|GuildRoll|TitanGuild|ChaosReserves|ChatLootBidder|EasyLoot|LootRes|RollFor|RoundRobinhood|LootBlare(?:2\.0)?|RaidRollBuddy|RaidRollHelper|SmartRoll|CleanRolls|XckMasterLootAdvanced|AutoMasterLooter|MasterLootByClass)$/i, 14],
	['Loot Distribution', /\b(?:loot distribution|loot (?:allocation|council|manager|management|assignment)|(?:dkp|ep[\s/-]?gp)\s+(?:manager|management|addon|auctions?|loot system)|(?:effort|gear) points?\s+(?:manager|management|system)|(?:soft reserve|soft-reserve) loot systems?|master[ -]?loot(?:er)?\s+(?:addon|assignment|distribution|automation)|(?:assign(?:ing)?|distribut(?:e|ing))\s+(?:raid\s+)?loot|(?:group loot|raid loot|loot) rolls?)\b/i, 24],
	['Libraries', /\b(?:library addon|function library|embedded librar(?:y|ies))\b/i, 11],
	['Class', /\b(?:for\s+(?:warriors?|paladins?|hunters?|rogues?|priests?|shamans?|mages?|warlocks?|druids?)|(?:warrior|paladin|hunter|rogue|priest|shaman|mage|warlock|druid)\s+(?:swing timer|rotation|auto shot))\b/i, 11],
	['Class', /\b(?:warrior|paladin|hunter|rogue|priest|shaman|mage|warlock|druid)\s+combat addon\b/i, 14],
	['Chat & Social', /\b(?:monitors?|filters?|search(?:es)?|alerts?|logs?)\s+(?:the\s+)?chat\b/i],
	['UI & Appearance', /\b(?:character|inspect(?:ion)?)(?:\s+stats?)?\s+(?:panels?|panes?|windows?|screens?|frames?)\b/i],
	['UI & Appearance', /\b(?:full (?:ui|interface)|ui (?:replacement|overhaul|compilation|pack)|replacement for the original|interface suite)\b/i],
	['Macros', /\bmacro\s+(?:helper|editor|debugger|system|conditions?|functionality|icons?|tooltips?|texts?)\b/i],
	['Macros', /\bcreat(?:e|ing)\s+(?:simple(?:\(er\))?\s+)?macros?\b/i],
	['Unit Frames', /\b(?:unit|raid|party|target|player|focus|pet)\s*frames?\b/i],
	['Unit Frames', /\b(?:name\s*plates?|portraits?|health\s*bars?)\b/i],
	['Action Bars', /\b(?:action\s*(?:bars?|buttons?)|keybindings?)\b/i],
	['Boss Mods', /\b(?:boss\s*mods?|boss encounters?|boss (?:alerts?|timers?)|world bosses?|raid warnings?|bigwigs|deadly boss)\b/i],
	['Bags & Inventory', /\b(?:bag|inventory|bank)\s+(?:manager|management|organizer|replacement|addon)\b|\b(?:sort|organize|manage)\s+(?:your\s+)?(?:bags|inventory)\b/i],
	['Auction & Economy', /\b(?:auction house|auction (?:management|addon)|vendor prices?|automatically sells?|sell all)\b/i],
	['Map & Minimap', /\b(?:minimap|world map)\s+(?:replacement|enhancement|addon|organizer)|\b(?:map|coordinate|waypoint)\s+(?:tracking|display|addon)\b/i],
	['Quests & Leveling', /\b(?:quest|leveling)\s+(?:helper|tracker|guide|addon)|\b(?:tracks?|displays?)\s+(?:your\s+)?(?:quests?|experience)|\bkills (?:till|to) level\b/i],
	['Buffs & Debuffs', /\b(?:buff|debuff|aura)\s+(?:tracking|tracker|monitor|reminder)|\b(?:tracks?|monitors?)\s+(?:your\s+)?(?:buffs?|debuffs?|auras?)\b/i],
	['Tooltip', /\b(?:tooltip\s+(?:replacement|enhancement|addon)|adds?\s+(?:information|stats?)\s+to\s+(?:item\s+)?tooltips?)\b/i],
	['Professions', /\b(?:crafting|trade\s*skill|profession)\s+(?:helper|window|addon|manager)|\b(?:profession|recipe)\s+(?:database|tracker|tracking)|\bGUI for (?:the )?\w+ Profession\b/i],
	['PvP', /\b(?:pvp|battleground|honor)\s+(?:tracker|tracking|helper|addon)|\b(?:tracks?|displays?)\s+(?:your\s+)?honor\b/i],
	['Raid & Party', /\b(?:raid assignments?|ready check)\b/i],
	['Combat', /\b(?:damage meters?|combat (?:logging|log|addon)|cast\s*bar\s+(?:addon|replacement)|threat\s+(?:meter|tracker))\b/i]
];

function evidence(pattern: RegExp, text: string, source: CategoryEvidence['source'], base: number, frameworkExtension: boolean): CategoryEvidence | undefined {
	for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g'))) {
		const before = text.slice(Math.max(0, match.index! - 35), match.index);
		const after = text.slice(match.index! + match[0].length);
		// Negated features and compatibility mentions do not describe this addon's purpose.
		if (/\b(?:without|does not|doesn't)(?:\s+\w+){0,2}\s*$/i.test(before) ||
			(/\bno(?:\s+\w+){0,2}\s*$/i.test(before) && /^\s+(?:required|needed)\b/i.test(after)) ||
			/^\s+(?:not required|not needed)/i.test(after) ||
			(/\b(?:for|requires?|with)\s*[a-z]*$/i.test(before) && /UI$/i.test(match[0]))) continue;
		let weight = base;
		if (/^buttons?$/i.test(match[0])) weight = 1;
		// A UI framework prefix on an extension is compatibility evidence, not its job.
		if (source === 'Name' && base === 3 && /ui$/i.test(match[0]) && frameworkExtension) weight = -13;
		if (source === 'Description' && /^mini-?maps?$/i.test(match[0]) && /^\s+(?:buttons?|icons?)\b/i.test(after)) weight = 1;
		// Every category clue in the addon's name gets the same priority bonus.
		return {source, text:match[0], weight:weight + (source === 'Name' ? 13 : 0)};
	}
}

/** Rank evidence rather than stopping at the first keyword. Repeated words and
 * overlapping rules cannot inflate scores: keep only the strongest clue per source.
 * Confidence describes rule evidence, not a measured probability of correctness. */
export function suggestCategory(name: string, description = ''): CategorySuggestion {
	const buckets = new Map<Category, CategoryEvidence[]>();
	for (const [category, pattern, base] of [
		...CATEGORY_RULES.map(([category, pattern]) => [category, pattern, 3] as const),
		...PURPOSES.map(([category, pattern, weight]) => [category, pattern, weight ?? 12] as const)
	]) {
		for (const [source, text] of [['Name', name], ['Name', apart(name)], ['Description', description]] as const) {
			const clue = evidence(pattern, text, source, base, /^\S*UI[-_]/.test(name));
			if (!clue) continue;
			const clues = buckets.get(category) ?? [];
			const previous = clues.findIndex(e => e.source === source);
			if (previous < 0) clues.push(clue);
			else if (clues[previous].weight < clue.weight) clues[previous] = clue;
			buckets.set(category, clues);
		}
	}
	const matches = [...buckets].map(([category, evidence]) => ({category, evidence, score:evidence.reduce((sum, e) => sum + e.weight, 0)}))
		.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
	const first = matches[0], margin = first ? first.score - (matches[1]?.score ?? 0) : 0;
	const confidence = first && (first.score >= 10 || first.evidence.some(e => e.weight >= 11)) && margin >= 4 ? 'Strong match'
		: first && margin >= 2 ? 'Possible match' : 'Uncertain';
	return {category:first?.category ?? DEFAULT_CATEGORY, confidence, matches};
}
