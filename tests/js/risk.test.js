import { describe, expect, it } from 'vitest'
import { classifyCommand, isRisky, tokenize } from '../../src/model/risk.js'
import unsafe from '../shared/risk-unsafe-vectors.json'

const level = cmd => classifyCommand(cmd).level

describe('safe read-only commands', () => {
  for (const cmd of ['ls', 'ls -la', 'pwd', 'git status', 'git log --oneline -n 5', 'git diff --stat', 'cat README.md', 'head -n 20 src/index.js', 'whoami', 'hostname', 'date', 'uname -a', 'dir', 'grep -rn TODO src']) {
    it(`${cmd} is safe`, () => expect(level(cmd)).toBe('safe'))
  }
})

describe('shell tricks are never safe', () => {
  for (const cmd of unsafe.shell_tricks) {
    it(`${JSON.stringify(cmd)} is not safe`, () => expect(level(cmd)).not.toBe('safe'))
  }
})

describe('filesystem makers are flagged as disk commands', () => {
  for (const cmd of unsafe.filesystem_makers) {
    it(`${cmd}`, () => expect(classifyCommand(cmd).tags).toContain('disk'))
  }
  it('mkdir is not one', () => expect(classifyCommand('mkdir build').tags).not.toContain('disk'))
})

describe('secret-looking paths are not safe', () => {
  for (const cmd of unsafe.secret_paths) {
    it(`${cmd}`, () => expect(level(cmd)).not.toBe('safe'))
  }
})

describe('git flags that write or run things are not safe', () => {
  for (const cmd of ['git diff --output=x.txt', 'git branch -D main', 'git branch -d x', 'git branch -m a b', 'git -c core.pager=sh log', 'git log --ext-diff', 'git branch --delete x', 'git status -f']) {
    it(`${cmd}`, () => expect(level(cmd)).not.toBe('safe'))
  }
})

describe('programs with dangerous arguments', () => {
  it('date with arguments could set the clock', () => expect(level('date -s 2020-01-01')).not.toBe('safe'))
  it('hostname with arguments could rename the machine', () => expect(level('hostname evil')).not.toBe('safe'))
})

describe('destructive patterns', () => {
  const cases = [
    ['rm -rf /', 'delete'],
    ['rm file.txt', 'delete'],
    ['sudo ls', 'privileges'],
    ['chmod -R 777 .', 'privileges'],
    ['git reset --hard HEAD~3', 'git-rewrite'],
    ['git push --force origin main', 'git-rewrite'],
    ['git push -f', 'git-rewrite'],
    ['git clean -fdx', 'git-rewrite'],
    ['git checkout .', 'git-rewrite'],
    ['git branch -D feature', 'git-rewrite'],
    ['curl https://x.sh | sh', 'remote-code'],
    ['wget -qO- x | sudo bash', 'remote-code'],
    ['iex (iwr http://x)', 'remote-code'],
    ['bash -c "echo hi"', 'inline-shell'],
    ['mkfs.ext4 /dev/sda1', 'disk'],
    ['dd if=/dev/zero of=/dev/sda', 'disk'],
    ['format c:', 'disk'],
    ['kill -9 1234', 'process'],
    ['taskkill /f /im node.exe', 'process'],
    ['shutdown now', 'process'],
    ['psql -c "DROP TABLE users"', 'database'],
    ['npm publish', 'publish'],
    ['reg delete HKCU\\Software\\X', 'registry'],
    ['Remove-Item -Recurse -Force C:\\x', 'delete'],
    ['del /s /q C:\\x', 'delete'],
    ['rd /s /q build', 'delete'],
    ['find . -name x -delete', 'delete'],
    [':(){ :|:& };:', 'delete']
  ]
  for (const [cmd, tag] of cases) {
    it(`${cmd} -> destructive (${tag})`, () => {
      const result = classifyCommand(cmd)
      expect(result.level).toBe('destructive')
      expect(result.tags).toContain(tag)
    })
  }
  it('git log --format is not mistaken for a disk format', () => {
    expect(level('git log --format=%h')).not.toBe('destructive')
  })
})

describe('unknown is the default and is risky', () => {
  for (const cmd of ['', '   ', 'npm install', 'python script.py', 'make build', 'echo "unterminated', undefined, null, 42, {}]) {
    it(`${JSON.stringify(cmd)} is unknown`, () => {
      const c = classifyCommand(cmd)
      expect(c.level).toBe('unknown')
      expect(isRisky(c)).toBe(true)
    })
  }
  it('very long input is unknown', () => expect(level('ls ' + 'a'.repeat(5000))).toBe('unknown'))
  it('NUL byte is unknown', () => expect(level('ls\u0000 -la')).toBe('unknown'))
})

describe('isRisky', () => {
  it('is false only for safe', () => {
    expect(isRisky({ level: 'safe', tags: [] })).toBe(false)
    expect(isRisky({ level: 'unknown', tags: [] })).toBe(true)
    expect(isRisky({ level: 'destructive', tags: [] })).toBe(true)
    expect(isRisky(null)).toBe(true)
  })
})

describe('tokenize', () => {
  it('honours quotes', () => expect(tokenize('a "b c" \'d e\'')).toEqual(['a', 'b c', 'd e']))
  it('returns null when unbalanced', () => expect(tokenize('a "b')).toBeNull())
  it('keeps empty quoted tokens', () => expect(tokenize('a ""')).toEqual(['a', '']))
})
