import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { LogReader } from './log-reader';

describe('LogReader', () => {
  const testDir = '/tmp/roy-debug-test';
  let reader: LogReader;

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
    reader = new LogReader({ logDir: testDir });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true });
  });

  describe('getLogPath', () => {
    test('should return default app.log path', () => {
      const path = reader.getLogPath();
      expect(path).toContain('app.log');
    });

    test('should return custom filename path', () => {
      const path = reader.getLogPath('custom.log');
      expect(path).toContain('custom.log');
    });

    test('should use absolute path directly', () => {
      const absPath = '/absolute/path/server.log';
      const path = reader.getLogPath(absPath);
      expect(path).toBe(absPath);
    });
  });

  describe('findLogFiles', () => {
    test('should return array of files', async () => {
      const files = await reader.findLogFiles();
      
      expect(Array.isArray(files)).toBe(true);
    });

    test('should handle custom pattern', async () => {
      // Create test log file
      writeFileSync(join(testDir, 'custom.log'), 'test log');

      const files = await reader.findLogFiles('custom.log');
      
      expect(Array.isArray(files)).toBe(true);
    });

    test('should use forward slashes for glob pattern (Windows compatibility)', async () => {
      // Create test log files
      writeFileSync(join(testDir, 'app.log'), 'test');
      writeFileSync(join(testDir, 'error.log'), 'test');

      const files = await reader.findLogFiles('*.log');
      
      // Verify files are found (proves glob pattern works)
      expect(files.length).toBeGreaterThanOrEqual(2);
      
      // Verify returned paths use forward slashes (not backslashes)
      for (const file of files) {
        expect(file).not.toContain('\\');
        expect(file).toContain('/');
      }
    });
  });

  describe('readLines', () => {
    test('should read lines from file', async () => {
      const testFile = join(testDir, 'read-test.log');
      writeFileSync(testFile, 'line1\nline2\nline3\n');

      const lines: string[] = [];
      for await (const line of reader.readLines(testFile)) {
        lines.push(line);
      }

      expect(lines).toEqual(['line1', 'line2', 'line3']);
    });

    test('should handle empty file', async () => {
      const testFile = join(testDir, 'empty.log');
      writeFileSync(testFile, '');

      const lines: string[] = [];
      for await (const line of reader.readLines(testFile)) {
        lines.push(line);
      }

      expect(lines).toEqual([]);
    });

    test('should handle file with trailing newline', async () => {
      const testFile = join(testDir, 'trailing.log');
      writeFileSync(testFile, 'line1\nline2\n');

      const lines: string[] = [];
      for await (const line of reader.readLines(testFile)) {
        lines.push(line);
      }

      expect(lines).toEqual(['line1', 'line2']);
    });
  });

  describe('filterByTime', () => {
    test('should filter by since time', async () => {
      const testFile = join(testDir, 'time-filter.log');
      writeFileSync(testFile, 
        '2026-04-08 10:00:00.000 line1\n' +
        '2026-04-08 11:00:00.000 line2\n' +
        '2026-04-08 12:00:00.000 line3\n'
      );

      const lines: string[] = [];
      for await (const line of reader.readLines(testFile, {
        since: '2026-04-08T11:00:00'
      })) {
        lines.push(line);
      }

      expect(lines.length).toBe(2);
      expect(lines[0]).toContain('11:00:00');
      expect(lines[1]).toContain('12:00:00');
    });

    test('should filter by until time', async () => {
      const testFile = join(testDir, 'until-filter.log');
      writeFileSync(testFile, 
        '2026-04-08 10:00:00.000 line1\n' +
        '2026-04-08 11:00:00.000 line2\n' +
        '2026-04-08 12:00:00.000 line3\n'
      );

      const lines: string[] = [];
      for await (const line of reader.readLines(testFile, {
        until: '2026-04-08T11:30:00'
      })) {
        lines.push(line);
      }

      expect(lines.length).toBe(2);
      expect(lines[0]).toContain('10:00:00');
      expect(lines[1]).toContain('11:00:00');
    });

    test('should filter by both since and until', async () => {
      const testFile = join(testDir, 'range-filter.log');
      writeFileSync(testFile, 
        '2026-04-08 10:00:00.000 line1\n' +
        '2026-04-08 11:00:00.000 line2\n' +
        '2026-04-08 12:00:00.000 line3\n'
      );

      const lines: string[] = [];
      for await (const line of reader.readLines(testFile, {
        since: '2026-04-08T10:30:00',
        until: '2026-04-08T11:30:00'
      })) {
        lines.push(line);
      }

      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('11:00:00');
    });
  });
});
