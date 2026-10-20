# import visualization libraries {
from algorithm_visualizer import Array2DTracer, Layout, LogTracer, Tracer, VerticalLayout
# }

# define tracer variables {
array2d_tracer = Array2DTracer('Grid')
log_tracer = LogTracer('Console')
# }

# define input variables
messages = [
    'Visualize',
    'your',
    'own',
    'code',
    'here!',
]


# highlight each line of messages recursively
def highlight(line):
    if line >= len(messages):
        return
    message = messages[line]
    # visualize {
    log_tracer.println(message)
    array2d_tracer.select_row(line, 0, len(message) - 1)
    Tracer.delay()
    array2d_tracer.deselect_row(line, 0, len(message) - 1)
    # }
    highlight(line + 1)


def main():
    # visualize {
    Layout.set_root(VerticalLayout([array2d_tracer, log_tracer]))
    array2d_tracer.set(messages)
    Tracer.delay()
    # }
    highlight(0)


main()
