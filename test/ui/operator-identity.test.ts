import { describe, expect, it, vi } from "vitest";
import {
  humanParticipants,
  operatorIdentityView,
  selectOperator
} from "../../public/js/operator-identity.js";

describe("operator identity control", () => {
  const participants = [
    { id: "operator-old", name: "Stephen", platformIdentity: "zoom:stephen" },
    { id: "client-1", name: "Maya" },
    {
      id: "bot-1",
      name: "Live Architect",
      isBot: true
    },
    { id: "operator-new", name: "Stephen", platformIdentity: "zoom:stephen" }
  ];

  it("excludes the bot and collapses a stable participant rejoin", () => {
    expect(humanParticipants(participants).map((participant) => participant.id))
      .toEqual(["operator-new", "client-1"]);
  });

  it("presents self-selection first and a correction action afterwards", () => {
    expect(operatorIdentityView(participants).map((participant) => ({
      id: participant.id,
      label: participant.roleLabel,
      action: participant.buttonText
    }))).toEqual([
      { id: "operator-new", label: "Not assigned", action: "This is me" },
      { id: "client-1", label: "Not assigned", action: "This is me" }
    ]);

    expect(
      operatorIdentityView(participants, "operator-new").map((participant) => ({
        id: participant.id,
        label: participant.roleLabel,
        action: participant.buttonText
      }))
    ).toEqual([
      { id: "operator-new", label: "Operator", action: "Selected" },
      { id: "client-1", label: "Client", action: "Make operator" }
    ]);
  });

  it("writes the exact selected participant to the session API", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ operatorParticipantId: "person-1" })
    );

    await expect(
      selectOperator("session-1", "person-1", fetchMock)
    ).resolves.toMatchObject({ operatorParticipantId: "person-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session-1/operator",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ participantId: "person-1" })
      })
    );
  });
});
