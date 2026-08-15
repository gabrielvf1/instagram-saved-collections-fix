As coleções de salvos do Instagram na web abriam vazias, na tela "Start Saving", com "All posts" funcionando normal.

Fui olhar o que o cliente pedia, e a causa estava na própria resposta do servidor.

Ao abrir uma coleção, o cliente web dispara requisições REST que voltam 404:

```
GET /api/v1/feed/collection/<id>/posts/?max_id=  -> 404
GET /api/v1/feed/collection/<id>/all/?max_id=    -> 404
```

Um endpoint irmão responde em texto, não com a página de erro:

```json
{"message":"Dead endpoint save.api.views.related_media unshipped.","status":"fail"}
```

Ou seja, o módulo `save.api.views.*` foi descontinuado no servidor, mas o bundle JavaScript do cliente ainda chama a rota antiga. "All posts" segue funcionando porque já usa o caminho novo, `/api/v1/feed/saved/posts/`. É um deploy fora de sincronia: o servidor foi adiante e o cliente ficou pra trás.

O contorno reconstrói a coleção a partir desse feed novo, que ainda responde 200 e traz o campo `saved_collection_ids` em cada item. Um userscript varre o feed uma vez, indexa em IndexedDB e filtra por coleção, depois intercepta a chamada morta e devolve uma resposta sintética no formato que o app espera.

É um contorno, não um conserto. A correção cabe à @Meta e ao @Instagram. Ele também depende do endpoint novo continuar existindo, e abrir a URL da coleção direto (F5) ainda falha, porque nesse caminho o app nem chama o REST.

Código e escrita completa no repo: https://github.com/gabrielvf1/instagram-saved-collections-fix

Um erro de deploy silencioso pode ficar semanas no ar num produto dessa escala, e a causa estava em uma linha da resposta do servidor, pra quem foi olhar.

...

Instagram's saved collections were opening empty on the web, on the "Start Saving" screen, while "All posts" kept working fine.

I went to look at what the client was requesting, and the cause was in the server's own response.

When you open a collection, the web client fires REST requests that come back 404:

```
GET /api/v1/feed/collection/<id>/posts/?max_id=  -> 404
GET /api/v1/feed/collection/<id>/all/?max_id=    -> 404
```

A sibling endpoint answers in plain text instead of the error page:

```json
{"message":"Dead endpoint save.api.views.related_media unshipped.","status":"fail"}
```

So the `save.api.views.*` module was retired on the server, but the client JavaScript bundle still calls the old route. "All posts" keeps working because it already uses the new path, `/api/v1/feed/saved/posts/`. This is an out of sync deploy: the server moved ahead and the client stayed behind.

The workaround rebuilds the collection from that new feed, which still returns 200 and carries a `saved_collection_ids` field on every item. A userscript sweeps the feed once, indexes it in IndexedDB and filters by collection, then intercepts the dead call and returns a synthetic response in the shape the app expects.

It is a workaround, not a fix. The correction belongs to @Meta and @Instagram. It also depends on the new endpoint continuing to exist, and opening the collection URL directly (F5) still fails, because on that path the app never calls the REST endpoint.

Code and full writeup in the repo: https://github.com/gabrielvf1/instagram-saved-collections-fix

A silent deploy error can sit live for weeks on a product this size, and the cause was in a single line of the server's response, for anyone who went to look.
