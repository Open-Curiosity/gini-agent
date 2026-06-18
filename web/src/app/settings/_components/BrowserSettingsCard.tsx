"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Spawn-only transport (issue #420): the agent drives a single per-instance
// headless Chrome it launches on demand — there is no managed window to open
// and no external Chrome to attach, so this card has no Connect/Disconnect
// controls. Sign-in to a site the agent needs happens in-place: when a browser
// task hits a sign-in wall the agent surfaces a Connect card in chat that
// screencasts that same headless Chrome, the user signs in once, and the login
// persists in the per-instance profile for every later task.
export function BrowserSettingsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Browser sign-ins</CardTitle>
        <CardDescription>How the agent signs in to sites it needs.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          The agent uses its own browser, launched automatically when a task needs the web.
          When it reaches a page that requires you to sign in, it opens a live view of that
          browser right here in chat — sign in once and the agent continues. Your saved
          logins persist for future tasks, so you only sign in to each site once.
        </p>
      </CardContent>
    </Card>
  );
}
