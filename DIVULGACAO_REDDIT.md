This looks like a broken deploy on Meta's side, and there is a client side workaround.

When you open a saved collection on the web, the client fires REST requests that come back 404:

```
GET /api/v1/feed/collection/<id>/posts/?max_id=  -> 404
GET /api/v1/feed/collection/<id>/all/?max_id=    -> 404
```

A sibling endpoint answers in plain text instead of the error page:

```json
{"message":"Dead endpoint save.api.views.related_media unshipped.","status":"fail"}
```

So the `save.api.views.*` module was retired on the server, but the client JavaScript bundle still calls the old route. That is why "All posts" still works (it already uses the new path, `/api/v1/feed/saved/posts/`) while individual collections open on the "Start Saving" screen.

The workaround rebuilds the collection from the new saved feed, which still returns 200 and carries a `saved_collection_ids` field on every item. A userscript sweeps that feed once, indexes it, and filters by collection id, then intercepts the dead call and returns a synthetic response in the shape the app expects.

How to run it:

1. Install Tampermonkey (Chrome extension).
2. Go to `chrome://extensions/`, open Tampermonkey's details, and enable "Allow user scripts". On recent Chrome (MV3) the script has no effect without this.
3. Add the script and open your saved page once to let it index.

Code and full writeup: https://github.com/gabrielvf1/instagram-saved-collections-fix

Honest caveats: it is a workaround, not a fix. It depends on `/api/v1/feed/saved/posts/` continuing to exist; if that one is retired too, it stops. And opening a collection URL directly (F5) still fails, because on that path the app never calls the REST endpoint, so there is nothing to intercept. You have to enter through the saved list and click the collection.

Worth noting that a silent deploy error can sit live for a while on a product this size, and the cause was in the server's own response ("Dead endpoint unshipped"), on a single line, for anyone who went to look.
