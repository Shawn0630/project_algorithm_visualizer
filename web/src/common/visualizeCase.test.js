import { buildCaseVisualization } from './visualizeCase';

const PUBLIC_SOLUTION = `import java.util.*;

public class Solution {
    public List<String> findFraudulentUsers(List<List<Object>> transactions, int k, int window_seconds) {
        return new ArrayList<>();
    }
}
`;

const PACKAGE_PRIVATE_SOLUTION = `import java.util.*;

class Solution {
    public List<String> findFraudulentUsers(List<List<Object>> transactions, int k, int window_seconds) {
        return new ArrayList<>();
    }
}
`;

describe('buildCaseVisualization - python', () => {
  const INSTRUMENTED_PAD = `from algorithm_visualizer import Array2DTracer, Layout, LogTracer, Tracer, VerticalLayout

array2d_tracer = Array2DTracer('Matrix')
log_tracer = LogTracer('Console')

def solve(data):
    array2d_tracer.set([[1, 2], [3, 4]])
    Tracer.delay()
    return [1, 2]

def main():
    Layout.set_root(VerticalLayout([array2d_tracer, log_tracer]))
    Tracer.delay()
    return solve([])

if __name__ == "__main__":
    main()
`;

  it('still clears the pad driver commands before the case runs', () => {
    const out = buildCaseVisualization('py', INSTRUMENTED_PAD, 'solve', [[]]);
    expect(out).toContain('del _VizCommander._commands[:]');
  });

  it('replays the pad tracers creation commands after the clear, so the case can keep talking to them', () => {
    const out = buildCaseVisualization('py', INSTRUMENTED_PAD, 'solve', [[]]);
    expect(out.indexOf('del _VizCommander._commands[:]')).toBeLessThan(out.indexOf('_VizCommander.replay_creates()'));
    expect(out.indexOf('_VizCommander.replay_creates()')).toBeLessThan(out.indexOf('_viz_target = None'));
  });

  it('keeps the pad own root above the harness views when the pad set one', () => {
    const out = buildCaseVisualization('py', INSTRUMENTED_PAD, 'solve', [[]]);
    expect(out).toContain('_viz_pad_root = _VizCommander._root');
    expect(out).toContain("if isinstance(_viz_pad_root, _VizCommander):");
    expect(out).toContain('_VizLayout.set_root(_VizVerticalLayout([_viz_pad_root] + _viz_views))');
    expect(out).toContain('_VizLayout.set_root(_VizVerticalLayout(_viz_views))');
  });
});

describe('buildCaseVisualization - java', () => {
  it('demotes a public entry class to package-private so the harness compiles as Main.java', () => {
    const out = buildCaseVisualization('java', PUBLIC_SOLUTION, 'Solution.findFraudulentUsers', [[['u1', 1]], 1, 10]);
    expect(out).not.toMatch(/\bpublic\s+class\s+Solution\b/);
    expect(out).toMatch(/\bclass\s+Solution\b/);
    expect(out).toMatch(/\bpublic\s+class\s+Main\b/);
    // The generated Main still reaches the entry class by reflection
    // and by instantiation in the same file.
    expect(out).toContain('Solution.class.getDeclaredMethods()');
    expect(out).toContain('new Solution()');
  });

  it('demotes a public entry class for a bare method entry too', () => {
    const out = buildCaseVisualization('java', PUBLIC_SOLUTION, 'findFraudulentUsers', [[['u1', 1]], 1, 10]);
    expect(out).not.toMatch(/\bpublic\s+class\s+Solution\b/);
    expect(out).toMatch(/\bclass\s+Solution\b/);
  });

  it('leaves a package-private entry class unchanged', () => {
    const out = buildCaseVisualization('java', PACKAGE_PRIVATE_SOLUTION, 'Solution.findFraudulentUsers', [[['u1', 1]], 1, 10]);
    expect(out).toContain('class Solution {');
    expect(out).not.toMatch(/\bpublic\s+class\s+Solution\b/);
  });

  it('keeps final/abstract modifiers when demoting the entry class', () => {
    const finalOut = buildCaseVisualization(
      'java',
      PUBLIC_SOLUTION.replace('public class Solution', 'public final class Solution'),
      'Solution.findFraudulentUsers',
      [[['u1', 1]], 1, 10]
    );
    expect(finalOut).not.toMatch(/\bpublic\s+class\s+Solution\b/);
    expect(finalOut).toMatch(/\bfinal\s+class\s+Solution\b/);

    const abstractOut = buildCaseVisualization(
      'java',
      PUBLIC_SOLUTION.replace('public class Solution', 'public abstract class Solution'),
      'Solution.findFraudulentUsers',
      [[['u1', 1]], 1, 10]
    );
    expect(abstractOut).not.toMatch(/\bpublic\s+class\s+Solution\b/);
    expect(abstractOut).toMatch(/\babstract\s+class\s+Solution\b/);
  });

  it('still rejects a file that already defines a Main class', () => {
    expect(() =>
      buildCaseVisualization('java', `${PUBLIC_SOLUTION}\npublic class Main {}`, 'Solution.findFraudulentUsers', [[], 1, 10])
    ).toThrow(/already defines a Main/);
  });

  it('still rejects a file without the entry class', () => {
    expect(() =>
      buildCaseVisualization('java', 'class Other {\n    public void f() {}\n}', 'Solution.findFraudulentUsers', [[], 1, 10])
    ).toThrow(/needs a class Solution/);
  });
});
