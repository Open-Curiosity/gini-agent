import { describe, expect, test } from "bun:test";
import { parseLeadingRouteDirective } from "./route-directive";

describe("parseLeadingRouteDirective", () => {
  test("recognizes a complete thread directive and strips it", () => {
    const result = parseLeadingRouteDirective("<route>thread</route>Here is the answer.");
    expect(result.status).toBe("directive");
    expect(result.route).toBe("thread");
    expect(result.rest).toBe("Here is the answer.");
  });

  test("recognizes a complete chat directive and strips it", () => {
    const result = parseLeadingRouteDirective("<route>chat</route>Quick reply.");
    expect(result.status).toBe("directive");
    expect(result.route).toBe("chat");
    expect(result.rest).toBe("Quick reply.");
  });

  test("trims whitespace/newlines after the directive", () => {
    const result = parseLeadingRouteDirective("<route>thread</route>\n\n  Body starts here.");
    expect(result.status).toBe("directive");
    expect(result.route).toBe("thread");
    expect(result.rest).toBe("Body starts here.");
  });

  test("tolerates leading whitespace before the directive", () => {
    const result = parseLeadingRouteDirective("  \n<route>thread</route> answer");
    expect(result.status).toBe("directive");
    expect(result.route).toBe("thread");
    expect(result.rest).toBe("answer");
  });

  test("is case-insensitive on the tag and value", () => {
    const result = parseLeadingRouteDirective("<ROUTE>Thread</ROUTE>X");
    expect(result.status).toBe("directive");
    expect(result.route).toBe("thread");
    expect(result.rest).toBe("X");
  });

  test("rest can be empty when the directive is the whole text", () => {
    const result = parseLeadingRouteDirective("<route>thread</route>");
    expect(result.status).toBe("directive");
    expect(result.route).toBe("thread");
    expect(result.rest).toBe("");
  });

  test("rest is empty when only trailing whitespace follows the directive", () => {
    const result = parseLeadingRouteDirective("<route>chat</route>   \n");
    expect(result.status).toBe("directive");
    expect(result.route).toBe("chat");
    expect(result.rest).toBe("");
  });

  describe("incomplete streaming prefixes", () => {
    test.each([
      "",
      "   ",
      "\n",
      "<",
      "<r",
      "<rou",
      "<route",
      "<route>",
      "<route>thr",
      "<route>thread",
      "<route>thread<",
      "<route>thread</rout",
      "<route>thread</route", // missing closing bracket
      "<route>ch",
      "<route>chat</route" // missing closing bracket
    ])("treats %p as incomplete", (prefix) => {
      expect(parseLeadingRouteDirective(prefix).status).toBe("incomplete");
    });

    test("a leading-whitespace prefix is still incomplete", () => {
      expect(parseLeadingRouteDirective("  <route>thr").status).toBe("incomplete");
    });
  });

  describe("non-directive content", () => {
    test("ordinary text yields none", () => {
      expect(parseLeadingRouteDirective("Here is a normal answer.").status).toBe("none");
    });

    test("unrecognized directive value yields none", () => {
      expect(parseLeadingRouteDirective("<route>foo</route>body").status).toBe("none");
    });

    test("text that merely contains a directive later is none", () => {
      expect(parseLeadingRouteDirective("Sure: <route>thread</route>").status).toBe("none");
    });

    test("a different leading tag is none", () => {
      expect(parseLeadingRouteDirective("<reply>thread</reply>").status).toBe("none");
    });

    test("a non-tag character that looks close is none", () => {
      expect(parseLeadingRouteDirective("x<route>thread</route>").status).toBe("none");
    });
  });
});
