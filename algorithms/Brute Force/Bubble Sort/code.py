# import visualization libraries {
from algorithm_visualizer import Tracer, Array1DTracer, ChartTracer, LogTracer, Randomize, Layout, VerticalLayout
# }

# define tracer variables {
chart = ChartTracer()
tracer = Array1DTracer()
logger = LogTracer()
Layout.set_root(VerticalLayout([chart, tracer, logger]))
D = Randomize.Array1D(15).create()
tracer.set(D)
tracer.chart(chart)
Tracer.delay()
# }

# logger {
logger.println('original array = [{}]'.format(', '.join(map(str, D))))
# }
N = len(D)
swapped = True
while swapped:
    swapped = False
    # visualize {
    tracer.select(N - 1)
    Tracer.delay()
    # }
    for i in range(1, N):
        # visualize {
        tracer.select(i)
        Tracer.delay()
        # }
        if D[i - 1] > D[i]:
            # logger {
            logger.println('swap {} and {}'.format(D[i - 1], D[i]))
            # }
            D[i - 1], D[i] = D[i], D[i - 1]
            swapped = True
            # visualize {
            tracer.patch(i - 1, D[i - 1])
            tracer.patch(i, D[i])
            Tracer.delay()
            tracer.depatch(i - 1)
            tracer.depatch(i)
            # }
        # visualize {
        tracer.deselect(i)
        # }
    # visualize {
    tracer.deselect(N - 1)
    # }
    N -= 1
# logger {
logger.println('sorted array = [{}]'.format(', '.join(map(str, D))))
# }
