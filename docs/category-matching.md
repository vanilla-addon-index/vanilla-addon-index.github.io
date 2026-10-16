# Category matching review

The matcher evaluates every category independently. General name evidence weighs 16, general description evidence 3, and standalone button evidence 1 in descriptions (14 in names). Specific purpose phrases weigh 12 (25 in names), with explicit class/library-purpose rules weighted separately. Only the strongest clue per category and source counts: repeated words, overlapping rules and CamelCase variants cannot inflate confidence. A minimap button/icon is weak map evidence. Negated requirements and UI compatibility mentions are discounted. Name variants are evaluated separately so concatenating them cannot invent a purpose phrase.

Strong match requires at least 10 points (or explicit purpose evidence) and a lead of at least 4. Possible match requires a lead of at least 2, with no minimum score. Everything else is Uncertain. Every category clue in an addon's name receives the same 13-point bonus over description evidence. This applies across all categories, so name matches take priority over competing README mentions. The existing discount for UI framework prefixes on extensions remains. These are heuristic evidence labels, not probabilities. Equal scores use category name order for a deterministic ranking and remain Uncertain.

Uncertain imports have a blank category, including no-evidence entries whose explanation falls back to Miscellaneous. No approval or version-add action is enabled until an admin explicitly picks a valid category. Keyboard approval is guarded too. Miscellaneous remains available as a deliberate choice. The existing published category constraint rejects a new page with no category. Admin selections remain authoritative; no score auto-approves an entry.

Import review evaluates confidence using current rules, independently of the selected category. Evidence remains available in the scoring module for diagnostics; the review UI omits explanations and only shows actionable status messages. Alternative wiki links may inherit a category without their own descriptive evidence; an uncertain review still requires an explicit choice. Deploy refresh writes current guesses, including blanks, into pending queue entries; published categories are not rewritten.

## Repository evidence

The nightly job now gathers extra category evidence for every pending repository import,
including imports that already have a category guess. Repository descriptions, `.toc`
Notes (including localized Notes), and README prose are stored separately in the queue's
`category_context`. Admin review ranks categories using this text alongside the wiki
description and addon name. The displayed choice and approval use the same result.
Public descriptions are unchanged. Wiki refreshes preserve the collected context.

README evidence is bounded to 6,000 characters after removing code blocks, images,
URLs, HTML markup, and Markdown installation/dependency/changelog/license sections.
Repository descriptions and TOC Notes are each bounded to 2,000 characters. Existing
confidence thresholds still apply. File checks reuse unchanged cached results; failed
checks preserve existing evidence and are retried on later runs. Supported repository
hosts are GitHub, GitLab, Codeberg, gitea.com and OctoWoW. Other links continue to use
the name and wiki description.

## Saved wiki comparison

Compared all 1082 entries at revision 23801. 529 are left blank for manual review under the conservative thresholds. The table lists 121 changed ranked suggestions relative to the former first-match rules, including alternative links evaluated independently. Ranked suggestions are retained as guidance even when selection is blank. These counts are not an accuracy measurement; old labels are not ground truth.

| Addon | Previous | Ranked suggestion | Confidence | Selection |
|---|---|---|---|---|
| AntiSpamStopCast | Action Bars | Combat | Strong match | Combat |
| AutoBar | Action Bars | Quests & Leveling | Uncertain | Manual choice required |
| AutoDot | Action Bars | Class | Uncertain | Manual choice required |
| BananaBar | Action Bars | Class | Uncertain | Manual choice required |
| BananaRepublicProfs | Chat & Social | Professions | Strong match | Professions |
| BattleScribe | Raid & Party | Combat | Uncertain | Manual choice required |
| Bloodrage | Action Bars | Class | Uncertain | Manual choice required |
| CallOfElements | PvP | Class | Uncertain | Manual choice required |
| Carbonite | Map & Minimap | Quests & Leveling | Strong match | Quests & Leveling |
| CatDruidDPS | Action Bars | Class | Uncertain | Manual choice required |
| ChatBar | Action Bars | Chat & Social | Strong match | Chat & Social |
| ChatLootBidder | Chat & Social | Raid & Party | Strong match | Raid & Party |
| ChatMonitor | Action Bars | Chat & Social | Strong match | Chat & Social |
| ChronicleCompanion | Raid & Party | Combat | Strong match | Combat |
| CliffTells | Quests & Leveling | Chat & Social | Uncertain | Manual choice required |
| CMap | Miscellaneous | Map & Minimap | Possible match | Map & Minimap |
| CombatAlert | Chat & Social | Combat | Strong match | Combat |
| CombatLoggingReminder | Raid & Party | Combat | Strong match | Combat |
| ConsumesManager | Bags & Inventory | Auction & Economy | Uncertain | Manual choice required |
| CooldownTimers | Bags & Inventory | Combat | Strong match | Combat |
| CooldownTracker | Buffs & Debuffs | Combat | Strong match | Combat |
| DamageMeters | Raid & Party | Combat | Strong match | Combat |
| DialogUI | Quests & Leveling | UI & Appearance | Strong match | UI & Appearance |
| DisableEscape | Action Bars | Chat & Social | Uncertain | Manual choice required |
| DKPList | Chat & Social | Raid & Party | Strong match | Raid & Party |
| DpsGirl | Chat & Social | Combat | Strong match | Combat |
| EasyPoisons | Auction & Economy | Class | Strong match | Class |
| EliteWarriorTTD | Boss Mods | Class | Possible match | Class |
| ElvUIModernized | Miscellaneous | UI & Appearance | Possible match | UI & Appearance |
| ExoRaidSetup | Boss Mods | Raid & Party | Strong match | Raid & Party |
| FadeFrameUI | Unit Frames | Action Bars | Uncertain | Manual choice required |
| FBHealBox | Miscellaneous | Raid & Party | Possible match | Raid & Party |
| FizzwidgetHuntersHelper | Tooltip | Class | Strong match | Class |
| ForgedSellAllGrays | Action Bars | Auction & Economy | Strong match | Auction & Economy |
| Gatherstone-Meeting | Quests & Leveling | Chat & Social | Uncertain | Manual choice required |
| GearSetTooltips | Bags & Inventory | Tooltip | Possible match | Tooltip |
| GrayAutoSell | Bags & Inventory | Auction & Economy | Strong match | Auction & Economy |
| GuildMap | Map & Minimap | Chat & Social | Uncertain | Manual choice required |
| HolyShift | Action Bars | Class | Strong match | Class |
| HunterAggroMeter | Class | Combat | Uncertain | Manual choice required |
| IWIN | Action Bars | Class | Strong match | Class |
| LazySpell | Raid & Party | Combat | Strong match | Combat |
| LockAssignment | Class | Raid & Party | Strong match | Raid & Party |
| LockPort | Map & Minimap | Class | Strong match | Class |
| LootCrestReminder | Boss Mods | Raid & Party | Strong match | Raid & Party |
| MasterLootRemind | Boss Mods | Raid & Party | Strong match | Raid & Party |
| MasterTradeSkills | Tooltip | Professions | Strong match | Professions |
| MinimapButtonBag | Action Bars | Map & Minimap | Possible match | Map & Minimap |
| MinimapButtonFrame | Action Bars | Map & Minimap | Strong match | Map & Minimap |
| MinimapMenu | Action Bars | Map & Minimap | Possible match | Map & Minimap |
| MiniMage_TWOW | Action Bars | Class | Strong match | Class |
| MobStats | Tooltip | Combat | Uncertain | Manual choice required |
| MoPGearTooltips | Quests & Leveling | Tooltip | Strong match | Tooltip |
| NotesUNeed | Quests & Leveling | Chat & Social | Uncertain | Manual choice required |
| NotChatLootBidder | Chat & Social | Raid & Party | Possible match | Raid & Party |
| OneButtonHunter | Action Bars | Class | Strong match | Class |
| PallyPower-Turtle | Buffs & Debuffs | Class | Possible match | Class |
| PaladinSalvaRemover | Buffs & Debuffs | Class | Possible match | Class |
| PartyPlus | Chat & Social | Raid & Party | Strong match | Raid & Party |
| PetXPBar | Quests & Leveling | Class | Uncertain | Manual choice required |
| pfUI-chatscrollbutton | Action Bars | UI & Appearance | Uncertain | Manual choice required |
| pfUI-lazyres | Libraries | UI & Appearance | Uncertain | Manual choice required |
| PicoPoisons | Buffs & Debuffs | Class | Strong match | Class |
| PizzaWorldBuffs | Map & Minimap | Buffs & Debuffs | Strong match | Buffs & Debuffs |
| PriestBinds | Action Bars | Class | Strong match | Class |
| Professionquery | Professions | Miscellaneous | Uncertain | Manual choice required |
| PVPToggleTurtle | Action Bars | PvP | Strong match | PvP |
| pwscounter | Raid & Party | Combat | Uncertain | Manual choice required |
| QuestTranslator | Quests & Leveling | Chat & Social | Uncertain | Manual choice required |
| QuickHealTurtle | Action Bars | Raid & Party | Strong match | Raid & Party |
| RABuffs | Raid & Party | Buffs & Debuffs | Possible match | Buffs & Debuffs |
| RaidRollBuddy | Action Bars | Raid & Party | Strong match | Raid & Party |
| RaidSummonPlus | Class | Raid & Party | Possible match | Raid & Party |
| RAT | Raid & Party | Combat | Uncertain | Manual choice required |
| RelationshipsThreatPlates | Unit Frames | Combat | Uncertain | Manual choice required |
| RoguePoker | Action Bars | Class | Strong match | Class |
| SortByBuyout | Action Bars | Auction & Economy | Strong match | Auction & Economy |
| SoulShardManager | Bags & Inventory | Class | Strong match | Class |
| SP_Overpower | Tooltip | Combat | Uncertain | Manual choice required |
| SP_Revenge | Tooltip | Combat | Uncertain | Manual choice required |
| StrategosBattleground | Map & Minimap | PvP | Strong match | PvP |
| StrategosCore | Quests & Leveling | PvP | Uncertain | Manual choice required |
| TankBuddy | Class | Raid & Party | Strong match | Raid & Party |
| TheorycraftTurtle | Action Bars | Macros | Uncertain | Manual choice required |
| Threat | Action Bars | Combat | Strong match | Combat |
| TotemBar | Action Bars | Class | Strong match | Class |
| TourGuideProfessions | Quests & Leveling | Professions | Uncertain | Manual choice required |
| TradeChat | Auction & Economy | Chat & Social | Strong match | Chat & Social |
| TrainerSkills | Professions | Class | Uncertain | Manual choice required |
| TWThreat-Octo | Miscellaneous | Combat | Possible match | Combat |
| UberBanish | Chat & Social | Class | Strong match | Class |
| UITweaks | Miscellaneous | UI & Appearance | Possible match | UI & Appearance |
| UnifiedTalentGuides | Quests & Leveling | Class | Uncertain | Manual choice required |
| VGAntiCooldown | Buffs & Debuffs | Combat | Possible match | Combat |
| WarriorCombatManager | Boss Mods | Combat | Possible match | Combat |
| WarriorTank | Action Bars | Class | Possible match | Class |
| WebDKPElysium | Chat & Social | Raid & Party | Strong match | Raid & Party |
| WhisperFilter | Auction & Economy | Chat & Social | Strong match | Chat & Social |
| WhoKicksNow | Raid & Party | Combat | Uncertain | Manual choice required |
| XLoot | Miscellaneous | Raid & Party | Possible match | Raid & Party |
| XToLevel-Classic | Quests & Leveling | Combat | Uncertain | Manual choice required |
| IWinEnhanced | Action Bars | Class | Uncertain | Manual choice required |
| Tankalyze | Raid & Party | Combat | Uncertain | Manual choice required |
| ShaguDPS | Class | Combat | Strong match | Combat |
| IchaUI | Unit Frames | UI & Appearance | Strong match | UI & Appearance |
| pfUI-DQB | Quests & Leveling | UI & Appearance | Uncertain | Manual choice required |
| Accountant | Auction & Economy | Miscellaneous | Uncertain | Manual choice required |
| aDF | Buffs & Debuffs | Miscellaneous | Uncertain | Manual choice required |
| AutoTurnIn | Quests & Leveling | Miscellaneous | Uncertain | Manual choice required |
| Bagshui | Bags & Inventory | Miscellaneous | Uncertain | Manual choice required |
| BattleMusic | Combat | Miscellaneous | Uncertain | Manual choice required |
| LifeSafer_LowHealthWarning | Combat | Miscellaneous | Uncertain | Manual choice required |
| MiniMage_TWOW | Action Bars | Class | Possible match | Class |
| Necrosis | Class | Miscellaneous | Uncertain | Manual choice required |
| Shootyepgp | Chat & Social | Miscellaneous | Uncertain | Manual choice required |
| Talentsaver | Class | Miscellaneous | Uncertain | Manual choice required |
| Threat | Action Bars | Combat | Possible match | Combat |
| TWPulse | Combat | Miscellaneous | Uncertain | Manual choice required |
| VanillaStoryline | Quests & Leveling | Miscellaneous | Uncertain | Manual choice required |
| VitalWatch | Chat & Social | Miscellaneous | Uncertain | Manual choice required |
| WhatsTraining_Turtle | Combat | Miscellaneous | Uncertain | Manual choice required |
