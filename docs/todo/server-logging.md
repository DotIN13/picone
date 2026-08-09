# Server logs go nowhere

`[picone] …` is stdout only — no file, no rotation, no request log. Fine for
`npm start > picone.log`, thin for anything else.
