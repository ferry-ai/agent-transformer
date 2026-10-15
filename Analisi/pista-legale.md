# Pista legale: termini d'uso e modalità conformi

*Analisi del 14 ottobre 2026. Raccoglie le considerazioni emerse nella discussione iniziale. Non è un parere legale.*

## Il problema

Per lavorare da agente servono più turni. Se a ogni turno lo script scrive e invia il messaggio nella pagina, e poi ne legge la risposta, per il servizio è automazione.

- **Termini d'uso di DeepSeek** (aggiornati al 27 marzo 2026). Il §3.5(3) vieta robot, spider e altri sistemi automatici, oltre alla cattura o copia dei contenuti del servizio. Il §3.3 riserva a DeepSeek il diritto di controllare con mezzi tecnici il comportamento degli utenti.
- **Sanzioni previste** (§8.2): limitazione delle funzioni dell'account, sospensione, chiusura, divieto di registrarsi di nuovo.
- Clausole simili si trovano nei termini della maggior parte delle chat consumer.

Il rischio concreto ricade soprattutto sull'account usato.

## I quattro passi di un turno

È lo schema che aider usa per la sua modalità copia-incolla:

1. preparare il messaggio (lato nostro);
2. incollarlo nella chat (lato sito);
3. copiare la risposta (lato sito);
4. applicarla (lato nostro).

Secondo aider la maggior parte dei termini vieta di automatizzare i passi 2 e 3, quindi aider li lascia manuali e automatizza solo l'1 e il 4. La linea non dipende da chi preme "invia": conta se il software scrive nella pagina del sito o ne legge le risposte.

## Modalità valutate

| Modalità | Cosa fa il tool sul sito | Termini d'uso | Stato |
|---|---|---|---|
| Consiglio di prompt (assistita) | niente: il prompt compare nella nostra interfaccia e negli appunti, l'utente incolla e copia | conforme | pista legale, da esplorare |
| Web con conferma | precompila il messaggio e legge la risposta; l'utente preme invio | automazione | possibile opzione di sicurezza della modalità web |
| Web automatica | scrive, invia e legge da solo | automazione, a rischio dell'utente | **implementazione attuale** (connettore DeepSeek) |
| API ufficiale | nessuna interazione con il sito | conforme | scartata: è a pagamento, cosa che il progetto vuole evitare |
| Connettori MCP ufficiali | è la chat a chiamare i nostri tool, con il permesso del provider | conforme dove supportato | da esplorare per altri provider (non DeepSeek) |

### Consiglio di prompt (modalità assistita)

È la strada gratuita e conforme. Il tool prepara il prompt e lo copia negli appunti; l'utente lo incolla nella chat, lo invia e clicca "copia" sulla risposta. Il tool tiene d'occhio gli appunti: quando arriva la risposta esegue i tool e prepara il prompt successivo. Per l'utente sono un Ctrl+V, un Invio e un clic a ogni turno. Se il modello mette più chiamate in una risposta, un task richiede pochi turni.

Vantaggi tecnici:

- nessun browser da pilotare e nessun selettore da mantenere;
- funziona da subito con qualunque chat web, senza un adapter per ciascuna.

### Perché "precompilare senza inviare" non basta

Il tool scriverebbe comunque nel campo della chat (passo 2). Per far girare il loop leggerebbe poi la risposta dalla pagina (passo 3). Il browser resta pilotato dal tool, quindi per il sito l'impronta tecnica è la stessa dell'automazione completa. Resta utile come conferma di sicurezza prima dell'invio, non come soluzione di conformità.

### Connettori MCP ufficiali

Alcuni provider permettono alla chat di chiamare un server MCP esterno:

- ChatGPT, con la Developer mode, con limiti diversi a seconda del piano;
- Claude, con i connettori personalizzati e, nell'app desktop, anche con server locali;
- Gemini: una fonte non ufficiale (giugno 2026) dice che la web app accetta server MCP remoti, da verificare;
- DeepSeek web non lo supporta.

In questo schema il loop lo fa la chat, mentre i blocchi "tool" e "loop" del progetto diventano un server MCP con i suoi limiti di iterazioni e di tempo. Il server deve essere raggiungibile in HTTPS e protetto da autenticazione.

## Decisioni al 14 ottobre 2026

- Si parte con un connettore web automatico verso DeepSeek. Il README avverte dei rischi e dichiara che il progetto non incoraggia la violazione dei termini d'uso.
- L'API ufficiale è scartata perché a pagamento.
- La modalità assistita resta la pista legale da esplorare in futuro.
- Impegni del progetto: nessun aggiramento di captcha o di sistemi anti-bot, nessun camuffamento del browser automatizzato. Se il sito chiede una verifica, il tool si ferma e passa il controllo all'utente.

## Altri rischi da tenere presenti

- **Account dedicato.** Meglio un account DeepSeek creato apposta, non quello personale.
- **Privacy.** Tutto ciò che l'agente legge viene inviato a DeepSeek. Secondo la loro privacy policy (almeno fino al 2025) i dati sono conservati su server in Cina: niente codice di lavoro né dati personali.
- **Italia.** A gennaio 2025 il Garante privacy ha limitato il trattamento dei dati degli utenti italiani e l'app è stata tolta dagli store; la versione web era rimasta raggiungibile. Lo stato nel 2026 non è stato verificato.

## Fonti

- [DeepSeek, Termini d'uso](https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html)
- [aider, Copy/paste with web chat](https://aider.chat/docs/usage/copypaste.html)
- [OpenAI, ChatGPT Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
- [Claude, connettori personalizzati con MCP remoto](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)
- [Gemini Custom Apps (MCP), fonte non ufficiale](https://skillsplayground.com/integrations/gemini/)
- [Open, il Garante blocca DeepSeek](https://www.open.online/2025/01/30/garante-privacy-blocca-deepseek-italia-chat-dati-rischi-ai-cina/)
- [SmartWorld, DeepSeek non disponibile in Italia su Android e iOS](https://www.smartworld.it/news/deepseek-non-disponibile-italia-android-ios.html)
