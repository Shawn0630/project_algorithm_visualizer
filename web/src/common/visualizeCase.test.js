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
  // An AI-written pad: the algorithm lives on Main as a static
  // method, Main's constructor runs a demo, and main() is the demo
  // driver. Its main() body carries braces inside a string and a
  // comment, so a naive brace match would replace the wrong span.
  const MAIN_STATIC_PAD = `import java.util.*;
import org.algorithm_visualizer.*;

public class Main {
    private Array1DTracer tracer = new Array1DTracer("values");

    public Main() {
        // demo constructor: must NOT run for a visualized case
        System.out.println("demo constructor ran");
    }

    public static List<List<String>> solveSecretSanta(String data) {
        return new ArrayList<>();
    }

    public static void main(String[] args) {
        // demo driver: must NOT run for a visualized case
        System.out.println("demo main ran { with braces }");
        // a comment with a brace }
        new Main();
    }
}
`;

  const MAIN_INSTANCE_PAD = `import java.util.*;

public class Main {
    public List<String> twice(String s) {
        List<String> out = new ArrayList<>();
        out.add(s);
        out.add(s);
        return out;
    }

    public static void main(String[] args) {
        System.out.println("demo");
    }
}
`;

  const MAIN_AND_SOLUTION_PAD = `import java.util.*;

public class Main {
    public static void main(String[] args) {
        System.out.println("demo");
    }
}

class Solution {
    public int twice(int n) {
        return n * 2;
    }
}
`;

  const MAIN_NO_MAIN_PAD = `import java.util.*;

public class Main {
    public static List<String> twice(String s) {
        return new ArrayList<>();
    }
}
`;

  const MAIN_ARGS_ARRAY_PAD = `import java.util.*;

public class Main {
    public static int twice(int n) {
        return n * 2;
    }

    public static void main(String args[]) throws Exception {
        System.out.println("demo");
    }
}
`;

  it('demotes a public entry class to package-private so the harness compiles as Main.java', () => {
    const out = buildCaseVisualization('java', PUBLIC_SOLUTION, 'Solution.findFraudulentUsers', [[['u1', 1]], 1, 10]);
    expect(out).not.toMatch(/\bpublic\s+class\s+Solution\b/);
    expect(out).toMatch(/\bclass\s+Solution\b/);
    expect(out).toMatch(/\bpublic\s+class\s+Main\b/);
    // The generated Main calls the shared harness with the entry
    // class, which reaches it by reflection and instantiates it
    // only for instance methods.
    expect(out).toContain('VizHarness.run(Solution.class, "findFraudulentUsers"');
    expect(out).toContain('class VizHarness');
    expect(out).toContain('getDeclaredConstructor()');
  });

  it('demotes a public entry class for a bare method entry too', () => {
    const out = buildCaseVisualization('java', PUBLIC_SOLUTION, 'findFraudulentUsers', [[['u1', 1]], 1, 10]);
    expect(out).not.toMatch(/\bpublic\s+class\s+Solution\b/);
    expect(out).toMatch(/\bclass\s+Solution\b/);
    expect(out).toContain('VizHarness.run(Solution.class, "findFraudulentUsers"');
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

  it('visualizes a Main file with a static entry instead of rejecting it', () => {
    const out = buildCaseVisualization('java', MAIN_STATIC_PAD, 'solveSecretSanta', ['Alice,Bob']);
    expect(out).toContain('VizHarness.run(Main.class, "solveSecretSanta"');
    expect(out).toContain('class VizHarness');
    // The demo main() body is gone, but the rest of Main is untouched.
    expect(out).not.toContain('demo main ran');
    expect(out).not.toContain('new Main()');
    expect(out).toContain('demo constructor ran');
    // Still exactly one public Main: no second Main class was appended.
    expect(out.match(/\bpublic\s+class\s+Main\b/g)).toHaveLength(1);
    // The harness was given the imports the file was missing, without
    // duplicating the ones it already had.
    expect(out.match(/import org\.algorithm_visualizer\.\*;/g)).toHaveLength(1);
    expect(out.match(/import java\.util\.\*;/g)).toHaveLength(1);
    expect(out).toContain('import com.google.gson.*;');
    expect(out).toContain('import java.lang.reflect.*;');
    // A static entry is invoked with a null target (no constructor run).
    expect(out).toContain('Object target = null;');
    expect(out).toContain('if (!Modifier.isStatic(method.getModifiers()))');
    expect(out).toContain('method.invoke(target, callArgs)');
  });

  it('accepts a class-qualified entry on a Main file', () => {
    const out = buildCaseVisualization('java', MAIN_STATIC_PAD, 'Main.solveSecretSanta', ['Alice,Bob']);
    expect(out).toContain('VizHarness.run(Main.class, "solveSecretSanta"');
    expect(out).not.toContain('demo main ran');
  });

  it('visualizes a Main file with an instance entry, instantiating it', () => {
    const out = buildCaseVisualization('java', MAIN_INSTANCE_PAD, 'twice', ['x']);
    expect(out).toContain('VizHarness.run(Main.class, "twice"');
    expect(out).not.toContain('demo');
    expect(out.match(/\bpublic\s+class\s+Main\b/g)).toHaveLength(1);
    // An instance entry is instantiated through the no-arg constructor.
    expect(out).toContain('getDeclaredConstructor()');
  });

  it('resolves a bare entry to Solution when a Main file also declares one', () => {
    const out = buildCaseVisualization('java', MAIN_AND_SOLUTION_PAD, 'twice', [21]);
    expect(out).toContain('VizHarness.run(Solution.class, "twice"');
    expect(out).not.toContain('demo');
    expect(out).toMatch(/\bpublic\s+class\s+Main\b/);
    expect(out).toMatch(/\bclass\s+Solution\b/);
    expect(out).not.toMatch(/\bpublic\s+class\s+Solution\b/);
  });

  it('adds a main() to a Main class that has none', () => {
    const out = buildCaseVisualization('java', MAIN_NO_MAIN_PAD, 'twice', ['x']);
    expect(out).toContain('VizHarness.run(Main.class, "twice"');
    expect(out).toContain('public static void main(String[] argv) {');
    expect(out.match(/\bpublic\s+class\s+Main\b/g)).toHaveLength(1);
  });

  it('replaces a main() written as String args[] with a throws clause', () => {
    const out = buildCaseVisualization('java', MAIN_ARGS_ARRAY_PAD, 'twice', [21]);
    expect(out).toContain('VizHarness.run(Main.class, "twice"');
    expect(out).not.toContain('demo');
    // The declaration (including its throws clause) is untouched.
    expect(out).toContain('public static void main(String args[]) throws Exception {');
  });

  it('resolves a bare entry to the file public class when there is no Solution', () => {
    const out = buildCaseVisualization(
      'java',
      'public class Foo {\n    public static int twice(int n) {\n        return n * 2;\n    }\n}\n',
      'twice',
      [21]
    );
    expect(out).toContain('VizHarness.run(Foo.class, "twice"');
    expect(out).toMatch(/\bclass\s+Foo\b/);
    expect(out).not.toMatch(/\bpublic\s+class\s+Foo\b/);
    expect(out).toMatch(/\bpublic\s+class\s+Main\b/);
  });

  it('still rejects a file without the entry class', () => {
    expect(() =>
      buildCaseVisualization('java', 'class Other {\n    public void f() {}\n}', 'Solution.findFraudulentUsers', [[], 1, 10])
    ).toThrow(/needs a class Solution/);
  });
});
