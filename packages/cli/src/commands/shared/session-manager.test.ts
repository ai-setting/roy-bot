/**
 * @fileoverview SessionManager Test
 * 
 * TDD: 测试 SessionManager 的核心功能
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import { SessionManager } from "./session-manager";
import { OutputService } from "../../services/output.service";

// Mock types
interface MockSession {
  id: string;
  title: string;
}

interface MockSessionComponent {
  getActiveSession: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  setActiveSession: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
}

describe("SessionManager", () => {
  let sessionManager: SessionManager;
  let mockSessionComponent: MockSessionComponent;
  let mockOutput: OutputService;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // 创建 mock SessionComponent
    mockSessionComponent = {
      getActiveSession: vi.fn(),
      get: vi.fn(),
      setActiveSession: vi.fn(),
      create: vi.fn(),
    };

    mockOutput = new OutputService();
    mockOutput.configure({ quiet: true });

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    sessionManager = new SessionManager({
      sessionComponent: mockSessionComponent as any,
      output: mockOutput,
      quiet: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("init()", () => {
    test("should create new session when no sessionId provided", async () => {
      // Given: no active session and no sessionId
      // First call to getActiveSession returns null (no active session)
      // First call to get() returns the newly created session
      mockSessionComponent.getActiveSession.mockResolvedValue(null);
      mockSessionComponent.create.mockResolvedValue({
        id: "sess_new123",
        title: "New Session",
      });
      mockSessionComponent.setActiveSession.mockResolvedValue(undefined);
      mockSessionComponent.get.mockResolvedValueOnce({
        id: "sess_new123",
        title: "New Session",
      });

      // When
      const result = await sessionManager.init();

      // Then
      expect(result.isNewSession).toBe(true);
      expect(result.sessionId).toBe("sess_new123");
      expect(mockSessionComponent.create).toHaveBeenCalledWith({
        title: expect.stringContaining("Session -"),
      });
    });

    test("should return existing session when sessionId exists", async () => {
      // Given: existing session
      const existingSession: MockSession = {
        id: "sess_existing",
        title: "Existing Session",
      };
      mockSessionComponent.get.mockResolvedValue(existingSession);
      mockSessionComponent.setActiveSession.mockResolvedValue(undefined);

      // When
      const result = await sessionManager.init("sess_existing");

      // Then
      expect(result.isNewSession).toBe(false);
      expect(result.sessionId).toBe("sess_existing");
      expect(result.sessionTitle).toBe("Existing Session");
      expect(mockSessionComponent.create).not.toHaveBeenCalled();
    });

    test("should create new session when specified sessionId does not exist", async () => {
      // Given: sessionId provided but doesn't exist
      // First call to get() returns null (session not found)
      // Second call to get() returns the newly created session
      mockSessionComponent.get
        .mockResolvedValueOnce(null) // first call - session not found
        .mockResolvedValueOnce({ id: "sess_new456", title: "New Session" }); // second call - new session
      mockSessionComponent.create.mockResolvedValue({
        id: "sess_new456",
        title: "New Session",
      });
      mockSessionComponent.setActiveSession.mockResolvedValue(undefined);

      // When
      const result = await sessionManager.init("sess_nonexistent");

      // Then
      expect(result.isNewSession).toBe(true);
      expect(result.sessionId).toBe("sess_new456");
      expect(mockSessionComponent.create).toHaveBeenCalled();
    });

    test("should continue last session when isContinue is true", async () => {
      // Given: active session exists
      // First call to getActiveSession returns the active session
      // First call to get() returns the active session
      const activeSession: MockSession = {
        id: "sess_active",
        title: "Active Session",
      };
      mockSessionComponent.getActiveSession.mockResolvedValue(activeSession);
      mockSessionComponent.setActiveSession.mockResolvedValue(undefined);
      mockSessionComponent.get.mockResolvedValueOnce(activeSession);

      // When
      const result = await sessionManager.init(undefined, true);

      // Then
      expect(result.sessionId).toBe("sess_active");
      expect(mockSessionComponent.getActiveSession).toHaveBeenCalled();
      expect(mockSessionComponent.create).not.toHaveBeenCalled();
    });

    test("should prefer explicit sessionId over continue flag", async () => {
      // Given: both sessionId and isContinue provided
      const existingSession: MockSession = {
        id: "sess_explicit",
        title: "Explicit Session",
      };
      mockSessionComponent.get.mockResolvedValue(existingSession);
      mockSessionComponent.setActiveSession.mockResolvedValue(undefined);

      // When: sessionId takes precedence
      const result = await sessionManager.init("sess_explicit", true);

      // Then
      expect(result.sessionId).toBe("sess_explicit");
      expect(mockSessionComponent.getActiveSession).not.toHaveBeenCalled();
    });
  });

  describe("switchSession()", () => {
    test("should switch to specified session", async () => {
      // Given
      const targetSession: MockSession = {
        id: "sess_target",
        title: "Target Session",
      };
      mockSessionComponent.get.mockResolvedValue(targetSession);
      mockSessionComponent.setActiveSession.mockResolvedValue(undefined);

      // When
      const result = await sessionManager.switchSession("sess_target");

      // Then
      expect(result.sessionId).toBe("sess_target");
      expect(result.sessionTitle).toBe("Target Session");
      expect(mockSessionComponent.setActiveSession).toHaveBeenCalledWith("sess_target");
    });
  });

  describe("getCurrentSession()", () => {
    test("should return current active session", async () => {
      // Given
      const activeSession: MockSession = {
        id: "sess_current",
        title: "Current Session",
      };
      mockSessionComponent.getActiveSession.mockResolvedValue(activeSession);

      // When
      const result = await sessionManager.getCurrentSession();

      // Then
      expect(result).toEqual(activeSession);
    });

    test("should return null when no active session", async () => {
      // Given
      mockSessionComponent.getActiveSession.mockResolvedValue(null);

      // When
      const result = await sessionManager.getCurrentSession();

      // Then
      expect(result).toBeNull();
    });
  });
});
