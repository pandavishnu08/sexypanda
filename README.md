# Pass It On

A responsive, single-page canvas game with solo play, online two-player co-op,
saved display names, and a shared SQLite leaderboard.

## Run locally

Requires Node.js 22 or newer.

```sh
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). The first player can
search for a partner and wait; the second player to search is paired
automatically. The host starts the shared game. Both players can pass the
logo, and either player's best result is saved for both names.

Choose **Play solo** to play alone. Display names are kept in that browser;
score entries and the top-ten leaderboard are stored by the server in
`data/leaderboard.sqlite`. Set `PORT`, `HOST`, or `DATABASE_PATH` to configure
the server and database location.

To play together from separate devices, publish the Node server at a public
HTTPS address and give both players the same game URL. Use a host with
persistent disk storage for SQLite so scores survive restarts and deployments.
The current leaderboard uses unverified display names and client-reported
results; it is intended for friendly play, not a secure or prize-based
competition.

## Included features

- Layouts adapt to wide desktop screens, narrow phones, coarse touch input,
  and short landscape screens.
- System, light, and dark appearance, high contrast, sound, and reduced-motion
  support.
- Live two-player matchmaking and cooperative play over Socket.IO.
- SQLite score storage and a leaderboard with each player's best result.
- In-game coaching tips for timing passes and coordinating with a teammate.

For a public competitive leaderboard, useful next steps are account sign-in,
server-verified game results, and moderation/reporting tools.

## Tests

```sh
npm test
```
