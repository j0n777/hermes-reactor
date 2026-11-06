# Demo: 82-second shot list (record on the real Hermes after upgrading)

For the author. English narration with the PT-BR line next to it. Record the Desktop window only, 1080p, the Reactor page in the middle
and the Reactor pane on the right. The graph is the wow moment: give it the biggest block of time. Nothing here needs
a paid API beyond your normal Hermes model. A window of 1280x720 or larger shows every view without scrolling; close the file
pane for the widest stage.

## Setup, before recording (about 10 minutes)

1. Upgrade Hermes to 0.23.0 or later, then install the plugin. `hermes plugins install` takes a Git URL or `owner/repo` (not a
   local path), so before the repository is public use the folder route:

   ```
   robocopy C:\path\to\jarbas-hermes "%HERMES_HOME%\plugins\hermes-reactor" /E /XD node_modules .git tests dev scripts src docs
   hermes plugins enable hermes-reactor
   ```

   Once it is on GitHub: `hermes plugins install <owner>/<repo> --enable`. Keep `plugins.isolation: in_process` (the default).
   Check with `hermes plugins validate "%HERMES_HOME%\plugins\hermes-reactor"`.

2. Open Hermes Desktop. A unified plugin's Desktop half ships disabled: open Settings, Plugins, switch **Reactor** on (one time).
   Also switch **Kanban** on, so the Kanban screen and the card badges exist. A "Reactor" row appears in the sidebar.

3. Make two extra profiles so the graph has company (any names; the demo says "writer" and "coder"):

   ```
   hermes profile create writer --clone
   hermes profile create coder --clone
   ```

   The plugin has to be enabled in each profile you want to talk to as well (`plugins.enabled` in its `config.yaml`) only if you
   want the persona line there; asking a profile does not need it.

4. Preview, then apply the voice setup:

   ```
   hermes reactor setup
   hermes reactor setup --apply
   hermes reactor setup --enable-wake --apply     # only if you want the wake word on; it opens the microphone
   ```

   The bundled wake phrase is **hey hermes** (proved live). If you have your own TensorFlow Lite model for another phrase,
   `hermes reactor setup --wake-model C:/path/to/model.tflite --wake-phrase "hey friday" --enable-wake --apply` (README, "Your
   own wake word model"). Rehearse a custom phrase with your real voice before you record.

5. Make two throwaway Claude Code sessions so the agents panel has something to show (scratch folders only), then wait two
   minutes so they count as idle:

   ```
   mkdir C:\temp\demo-auth ; cd C:\temp\demo-auth ; claude -p "Fix the login flow and add a refresh token test"
   ```

6. In Hermes, load the persona once: ask "load the hermes-reactor skill" (or `skill_view("hermes-reactor:reactor")`).
7. Check `approvals.mode: manual` (so the approval card is real, not skipped).
8. Do the delegation prompt (shot 2) and the profile ask (shot 4) once off camera so models and profile backends are warm.

## Shot list (82 seconds; the hackathon limit is 90)

The stage has one view at a time (`Reactor | Graph | Agents`), so the page never scrolls and each shot has one subject. Two
rules of the product shape the timing, so leave room for them instead of cutting around them:

- **Three seconds between screen changes.** `reactor_show` opens one screen per 3 seconds, and none while a card is waiting.
  This cut opens the graph, then Kanban, so it fits; do not ask for two screens in one breath.
- **700 ms before a button works.** Allow, Run and Send unlock 700 ms after a card appears and again 700 ms after its text
  or size changes. Pause on the card for a second (that is also the time the viewer needs to read it) and then click.

| Time | Show | Narration (EN) | Linha (PT-BR) |
|---|---|---|---|
| 0:00 to 0:06 | The **Reactor** view. The header reads **Hermes**; the reactor is large in the middle. | "Reactor turns Hermes into a command center." | "O Reactor transforma o Hermes numa central de comando." |
| 0:06 to 0:11 | Say "hey hermes". The reactor turns cyan and says listening. | "Wake word, then just talk." | "Diga a palavra de ativação e fale." |
| 0:11 to 0:41 | **The wow.** Say: "Show me the graph. Then split this into two helpers and have them work in parallel." The stage switches to **Graph** by itself, Hermes is the central node wearing the reactor, your profiles around it. Two subagent nodes pop out, cyan and pulsing. Click one: the detail panel shows its goal, model, last tool, tokens, duration. The other finishes: green check. | "Hermes delegates, and you watch it happen. Each subagent is a node. Click one for its goal, model, tool, tokens and time." | "O Hermes delega e você vê acontecer. Cada subagente é um nó. Clique em um para ver objetivo, modelo, ferramenta, tokens e tempo." |
| 0:41 to 0:47 | Say: "Show me the Kanban." The screen switches by itself. | "Ask for a screen, and it opens." | "Peça uma tela e ela abre." |
| 0:47 to 1:06 | Say: "Ask the writer profile for a tagline." A large card rises above the view: **writer**, "written by the assistant", the exact message. (To show the red banner, switch that profile's approvals off beforehand.) Pause one second, click Send. The reply appears on the card. | "Talk to any profile. Nothing is sent until you click, and the card shows the exact words." | "Fale com qualquer perfil. Nada é enviado até você clicar, e o cartão mostra as palavras exatas." |
| 1:06 to 1:16 | Ask Hermes to run a risky command (`rm -rf` on a scratch folder). The approval card explains it in plain language. Pause, click Deny. | "Every approval gets a plain-language card. Destructive commands never offer Always." | "Toda aprovação ganha um cartão em linguagem simples. Comandos destrutivos nunca têm Sempre." |
| 1:16 to 1:22 | Open the name editor in the side panel, pick **Jarbas**. The header changes. | "And it answers to the name you pick." | "E responde pelo nome que você escolher." |

Total: 82 seconds, of which the graph is 30. Model waits will run longer than this on camera: cut them in the edit and check the
final file is under 90 seconds before posting. If it runs over, drop the name editor first.

## Notes while recording

- The graph needs subagents to be interesting. With a real model, ask for a task that parallelises ("research these two things in
  parallel"). The lab used a fake model with two 8 and 12 second children so the nodes stay on screen.
- The wake window ends when your turn starts or after 20 seconds. Start speaking right after the cue.
- The graph refreshes from Hermes every 6 seconds while the page is open, and live events arrive between refreshes. After a
  dropped connection running nodes are dimmed until Hermes confirms them.
- If a card says it is unavailable, the routes refused the window: use a local Desktop and keep `plugins.isolation: in_process`.
- The "writer" reply comes through the other profile's own model and tools. Use throwaway profiles with no secrets.
- Show nothing from `%USERPROFILE%\.claude` beyond the demo sessions. Use throwaway folders, not real projects.
- Do not record the microphone level or a real transcript with personal content.
