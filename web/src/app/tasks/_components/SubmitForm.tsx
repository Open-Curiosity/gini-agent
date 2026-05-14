"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function SubmitForm({
  input,
  pending,
  onChange,
  onSubmit
}: {
  input: string;
  pending: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">New task</CardTitle>
        <CardDescription>e.g. read README.md, write x.txt :: hello</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          autoComplete="off"
          data-form-type="other"
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending || !input.trim()) return;
            onSubmit();
          }}
        >
          <Textarea
            name="gini-task-input"
            value={input}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Ask Gini to do something"
            autoComplete="off"
            data-form-type="other"
            data-lpignore="true"
            data-1p-ignore="true"
            className="min-h-24"
          />
          <Button
            type="submit"
            disabled={pending || !input.trim()}
            className="w-full"
          >
            {pending ? "Submitting…" : "Submit task"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
