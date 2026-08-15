# Instagram Saved Collections Fix

A client side workaround for when Instagram's saved collections open empty on the web.

**Language / Idioma:** [English](#english) | [Português](#português)

---

## English

A client side workaround for when Instagram's saved collections open empty on the web.

### The problem

Saved collections open empty, showing the "Start Saving" screen, even though their cover thumbnails still render in the collections list. "All posts" keeps working. Other users have been reporting the same thing for about a week, including inside the app (this is a secondhand report, not our own measurement).

### The diagnosis

When you open a collection, the web client fires REST requests that come back 404:

```
GET /api/v1/feed/collection/<id>/posts/?max_id=  -> 404
GET /api/v1/feed/collection/<id>/all/?max_id=    -> 404
```

A sibling endpoint answers in plain text instead of the error page:

```json
{"message":"Dead endpoint save.api.views.related_media unshipped.","status":"fail"}
```

In other words, the `save.api.views.*` module was retired on the server. It is not cache, not the session, not an extension. The client JavaScript bundle still calls the old route. "All posts" works because it already uses the new path, `/api/v1/feed/saved/posts/`. This is an out of sync deploy: the server moved ahead and the client stayed behind.

### The solution

The new saved feed still answers 200, and every item carries a `saved_collection_ids` field. The script sweeps the saved feed once, indexes it in IndexedDB (resumable, persisted page by page), and rebuilds any collection by filtering on that field. It intercepts the dead call (both `fetch` and `XMLHttpRequest`) and returns a synthetic response in the shape the app expects.

### Installation, step by step

Written for non technical users.

1. Install **Tampermonkey** (a Chrome extension).
2. Go to `chrome://extensions/`, open Tampermonkey's details, and enable **"Allow user scripts"**. Why: without it, on recent Chrome (MV3) the script is injected into an isolated world and has no effect.
3. Add the script to Tampermonkey, preferably through the repo's raw link:
   [install `instagram-saved-fix.user.js`](https://raw.githubusercontent.com/gabrielvf1/instagram-saved-collections-fix/main/instagram-saved-fix.user.js)
4. Open Instagram, go to the saved page, and let it index once (it takes a few minutes; it stays cached for 7 days, with incremental top ups afterward).

### Caveats

- It is a workaround, not a fix. Meta is the one who fixes it.
- It depends on `/api/v1/feed/saved/posts/` continuing to exist. If that one is retired too, the script stops working.
- Opening the collection URL directly (F5) still fails, because on that path the app never even calls the REST endpoint, so there is nothing to intercept. It works by entering through the saved list and clicking the collection.

### Troubleshooting

- **Script has no effect:** you did not enable "Allow user scripts" in Chrome (injection into an isolated world).
- **Grid freezing after a few items:** the filter is sparse and does not fill the viewport, so infinite scroll never fires. The script works around it by returning the whole collection at once.
- **Scan restarting from scratch:** the index is written page by page to IndexedDB (not localStorage, which would blow past the 5 MB quota), so it is resumable.

### Closing note

A silent deploy error can sit live for weeks on a product this size, and the cause was in the server's own response ("Dead endpoint unshipped"), on a single line, for anyone who went to look.

---

## Português

Um contorno client side pra quando as coleções de salvos do Instagram na web abrem vazias.

### O problema

As coleções de salvos abrem vazias, na tela "Start Saving", mesmo com as capas ainda aparecendo na listagem das coleções. "All posts" continua funcionando. Relatos de outros usuários indicam o mesmo problema há cerca de uma semana, inclusive no app (é relato de terceiros, não medição própria).

### O diagnóstico

Ao abrir uma coleção, o cliente web dispara requisições REST que voltam 404:

```
GET /api/v1/feed/collection/<id>/posts/?max_id=  -> 404
GET /api/v1/feed/collection/<id>/all/?max_id=    -> 404
```

Um endpoint irmão responde em texto, não com a página de erro:

```json
{"message":"Dead endpoint save.api.views.related_media unshipped.","status":"fail"}
```

Ou seja, o módulo `save.api.views.*` foi descontinuado no servidor. Não é cache, não é sessão, não é extensão. O bundle JavaScript do cliente ainda chama a rota antiga. "All posts" funciona porque já usa o caminho novo, `/api/v1/feed/saved/posts/`. É um deploy fora de sincronia: o servidor foi adiante e o cliente ficou pra trás.

### A solução

O feed de salvos novo ainda responde 200 e cada item traz o campo `saved_collection_ids`. O script varre o feed de salvos uma vez, indexa em IndexedDB (retomável, persistido página a página), e reconstrói qualquer coleção filtrando por esse campo. Ele intercepta a chamada morta (tanto `fetch` quanto `XMLHttpRequest`) e devolve uma resposta sintética no formato que o app espera.

### Instalação passo a passo

Pensada pra quem não é técnico.

1. Instalar o **Tampermonkey** (extensão do Chrome).
2. Ir em `chrome://extensions/`, abrir os detalhes do Tampermonkey e ativar **"Permitir scripts do utilizador" / "Allow user scripts"**. Por quê: sem isso, em Chrome novo (MV3) o script injeta num mundo isolado e não faz efeito.
3. Adicionar o script no Tampermonkey, de preferência pelo link raw do repo:
   [instalar `instagram-saved-fix.user.js`](https://raw.githubusercontent.com/gabrielvf1/instagram-saved-collections-fix/main/instagram-saved-fix.user.js)
4. Abrir o Instagram, ir na página de salvos e deixar indexar uma vez (leva alguns minutos; fica cacheado por 7 dias, com atualização incremental depois).

### Ressalvas

- É um contorno, não um conserto. Quem corrige é a Meta.
- Depende de `/api/v1/feed/saved/posts/` continuar existindo. Se ele também sair, o script para.
- Abrir a URL da coleção direto (F5) ainda falha, porque nesse caminho o app nem chama o endpoint REST, então não há o que interceptar. Funciona entrando pela lista de salvos e clicando na coleção.

### Troubleshooting

- **Script não faz efeito:** faltou ativar "Allow user scripts" no Chrome (injeção em mundo isolado).
- **Grade travando em poucos itens:** o filtro é esparso e não enche a viewport, então o scroll infinito não dispara. O script contorna devolvendo a coleção inteira de uma vez.
- **Varredura reiniciando do zero:** o índice é gravado página a página no IndexedDB (não localStorage, que estoura os 5 MB de quota), então é retomável.

### Nota de fechamento

Um erro de deploy silencioso pode ficar semanas no ar num produto dessa escala, e a causa estava na própria resposta do servidor ("Dead endpoint unshipped"), em uma linha, pra quem foi olhar.
