# Ollama Offline Coding Agent for VS Code

Lokálny agentický programovací systém pre VS Code. Používa iba Ollama API na
`127.0.0.1:11434`; nevyžaduje účet, cloudové API ani internetové pripojenie.

## Inštalácia z GitHub Releases

V časti **Releases** projektu stiahni súbor
`ollama-offline-agent-<verzia>.vsix`. Vo VS Code vyber
**Extensions: Install from VSIX...**, alebo spusti:

```powershell
code --install-extension .\ollama-offline-agent-<verzia>.vsix
```

Potom vykonaj **Developer: Reload Window**. Na spustenie potrebuješ lokálne
nainštalovanú a spustenú Ollamu; samotný agent po stiahnutí modelu funguje
offline.

Predvolený model je `qwen2.5-coder:32b-instruct-24T`, ktorý je v tomto počítači
už nainštalovaný. Agent dokáže čítať a prehľadávať projekt, upravovať súbory,
spúšťať testy a pokračovať v slučke nástrojov, až kým úlohu nedokončí alebo ho
nezastavíš.

Po inštalácii nájdeš v ľavom Activity Bare ikonu **Ollama Agent**. Otvorí vlastný
chat panel podobný Copilot/Codex chatu: má históriu správ, pole na zadanie úlohy,
`Send`, `Stop` a `Model`. Panel je implementovaný lokálne v tomto rozšírení a
neodosiela obsah konverzácie žiadnej cloudovej službe.

Pre praktickejšiu prácu spusti **Ollama Offline Agent: Open Chat in Editor**.
Chat sa otvorí ako karta vedľa editora (typicky napravo) a ostane otvorený pri
prepínaní medzi Explorerom, Gitom a inými VS Code modulmi.

Pre pravý panel v štýle Copilot/Codex spusti **Ollama Offline Agent: Open in
Secondary Side Bar…** a v natívnom VS Code výbere potvrď **Secondary Side Bar**.
VS Code si toto rozloženie pamätá.

Chat zobrazuje iba tvoje zadania a finálne odpovede agenta. Detailný priebeh
agentických krokov, nástroje a ich výsledky sú vo VS Code výstupe **Ollama
Offline Agent**.

História chatu aj kontext pre model sa ukladajú lokálne, takže po príkaze
`Developer: Reload Window` môžeš prirodzene pokračovať v konverzácii. Ak chceš
kontext zahodiť, spusti **Ollama Offline Agent: Start New Chat**.

História konkrétneho projektu je uložená v `.ollama-agent/chat-history.json`
pod jeho koreňom. Kompletná história ostáva k dispozícii v UI. Model dostane
posledné správy (nastavenie `ollamaOffline.contextMessages`) iba pri výslovnom
nadviazaní na predchádzajúcu úlohu, napríklad „pokračuj“, „uprav to“ alebo
„otestuj to“. Samostatná nová otázka sa posiela bez starej konverzácie, aby
staré požiadavky neovplyvňovali jej riešenie.

Agent nemá predvolený časový ani krokový limit: beží, kým úlohu nedokončí alebo
ho nezastavíš. `ollamaOffline.maxSteps` a `ollamaOffline.commandTimeoutSeconds`
môžu nastaviť voliteľné bezpečnostné limity; hodnota `0` znamená bez limitu.

Pri úlohe s testami agent po neúspešnom teste pokračuje diagnostikou,
korekciou a opätovným testom. Ak úlohu nevie dokončiť, má uviesť konkrétny
blokér aj výsledok zlyhaného príkazu.

Použi paperclip pri inpute alebo pretiahni súbor či obrázok priamo do composera.
Prílohy sa lokálne uložia do `.ollama-agent/resources/`; do nasledujúcej úlohy
sa vložia ich cesty. Obrázky sa odošlú aj modelu, ak vybraný Ollama model
podporuje obrazový vstup.

## Spustenie vo VS Code

1. Otvor tento priečinok vo VS Code.
2. Stlač `F5`. Otvorí sa **Extension Development Host** s rozšírením aktívnym.
3. V novom okne otvor priečinok projektu, ktorý chceš upravovať.
4. Spusť paletu príkazov (`Ctrl+Shift+P`) a vyber **Ollama Offline Agent: Ask Agent**.
5. Zadaj úlohu. Priebeh sleduj vo výstupnom kanáli **Ollama Offline Agent**.

Pre trvalú inštaláciu vytvor VSIX pomocou:

```powershell
powershell -ExecutionPolicy Bypass -File ./package-vsix.ps1
code --install-extension ./ollama-offline-agent-0.1.0.vsix
```

Oba kroky fungujú bez internetu. Po inštalácii reštartuj VS Code a príkaz bude
dostupný v každom pracovnom priestore.

## Vydanie novej verzie

1. Uprav `version` v `package.json`.
2. Over syntax a vytvor VSIX: `powershell -ExecutionPolicy Bypass -File ./package-vsix.ps1`.
3. Commitni zdrojové zmeny a vytvor Git tag `v<verzia>`.
4. Na GitHube vytvor release z tohto tagu a pridaj vytvorený `.vsix` ako asset.
5. Do release notes uveď najdôležitejšie zmeny a inštalačný príkaz z kapitoly vyššie.

## Model a prístup

Pre zmenu modelu spusti z palety príkazov **Ollama Offline Agent: Select
Installed Model**. Zobrazí sa roletka priamo z lokálne nainštalovaných modelov
Ollama; výber sa uloží globálne vo VS Code.

Predvolený režim `workspace` nedovolí agentovi opustiť otvorený projekt. Ak
potrebuješ prístup mimo neho, nastav `ollamaOffline.accessMode` na
`guardedSystem`. Vtedy môže čítať a meniť súbory aj na absolútnych cestách a
spúšťať príkazy s vlastným pracovným priečinkom, ale každá zmena/príkaz stále
vyžaduje tvoje potvrdenie. Zápis do kritických systémových ciest a deštruktívne
príkazy sú blokované. Chránené cesty upravíš cez `ollamaOffline.protectedPaths`.

Agent si vie nástrojom `save_skill` uložiť opakovane použiteľný lokálny
**playbook** — Markdown inštrukcie pre budúce úlohy. Nie je to nová technická
schopnosť ani nový prístup do systému. Spravuj playbooky príkazom **Ollama
Offline Agent: Open Local Skills Folder**; pri ďalšej úlohe sa automaticky
načítajú ako inštrukcie.

## Bezpečnosť

- Agent pracuje len pod koreňovým priečinkom otvoreného workspace.
- Každá zmena súboru a každý príkaz do shellu vyžadujú potvrdenie vo VS Code.
- Čítanie a vyhľadávanie sú bez potvrdenia.
- Aktívnu úlohu ukončí príkaz **Ollama Offline Agent: Stop Current Run**.

Nastavenia sa nachádzajú v `Settings` po vyhľadaní `Ollama Offline Agent`.
Najdôležitejšie sú model, maximálny počet krokov a časový limit pre príkazy.

## Predpoklady

- nainštalovaný VS Code
- bežiaca lokálna služba Ollama (`ollama serve`, ak ešte nebeží)
- aspoň jeden model s podporou tool calling; Qwen 2.5 Coder je odporúčaný

Overenie služby:

```powershell
ollama list
Invoke-RestMethod http://127.0.0.1:11434/api/version
```
