import React from "react";
import { Callout } from "../../components/Prose.js";
import { Ucb1Visualiser } from "../../components/Ucb1Visualiser.js";
import { TutorialPage } from "./TutorialPage.js";

export function CrossProcess() {
  return (
    <TutorialPage
      step={5}
      next={{ href: "#/parity", label: "Next: the platform parity matrix" }}
      intro={
        <>
          <h1>Cross-Process Events over UCB1</h1>
          <p>
            Several processes can share one cache file. UCB1 is the small binary protocol they use to tell each other that
            something changed, so a second process can invalidate its copy without polling. One process becomes the hub and the
            others connect to it as clients.
          </p>
        </>
      }
      visualiser={<Ucb1Visualiser headingLevel="h2" />}
      after={
        <>
          <h2>What you will see</h2>
          <p>
            Compose a frame to see its header bytes, press Publish frame and watch which process inboxes receive it. The topic
            filters control who is subscribed; the other publish buttons send deliberately broken frames. The page
            has its own note on how the simulation differs from the real hub.
          </p>
          <h2>The rules to remember</h2>
          <ul>
            <li>
              A frame is a 12-byte big-endian header (magic bytes <code>UCB1</code>, a type byte, flags, reserved bytes and a
              uint32 payload length) followed by a JSON payload of at most 1,048,576 bytes. There is no version field.
            </li>
            <li>
              The first frame from a client must be HELLO with a valid token. Otherwise the client gets ERROR INVALID_TOKEN and
              is closed.
            </li>
            <li>
              A client with no subscriptions receives every event. Subscriptions are exact-match filters on the payload&apos;s
              kind, tags or topic, plus <code>*</code>. The publisher does not receive its own event.
            </li>
            <li>
              A frame that fails to decode makes the hub destroy that socket without an ERROR reply. A slow consumer gets RESYNC.
            </li>
          </ul>
          <Callout tone="warn" title="TypeScript only">
            The hub and client are implemented in TypeScript for Node only (<code>node:net</code>). Dart and C# have the frame codec and hub-record bookkeeping but no
            socket server or client, so they cannot take part in this bus yet.
          </Callout>
        </>
      }
    />
  );
}
