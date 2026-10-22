import React from 'react';
import faColumns from '@fortawesome/fontawesome-free-solid/faColumns';
import { Button } from 'components';
import { classes } from 'common/util';
import { BUILTIN_LAYOUTS, PANE_NAMES, sameLayout } from 'common/layouts';
import styles from './LayoutsMenu.module.scss';

// The workspace layout picker. Layouts are designed around this
// app's own panes, not borrowed from another product:
//   Default - the native strip (Navigator / Visualization /
//     Editor / AI Assistant), AI closed.
//   Focus - a 2x2 grid: problem Markdown top-left, Visualization
//     bottom-left, code pad top-right, Testcase panel bottom-
//     right (starting collapsed).
//   AI - the strip with the AI Assistant open on the right.
// The user can snapshot the current arrangement (either mode)
// under their own name. The popover is positioned fixed, anchored
// to the button: the header clips overflow, so an absolutely
// positioned popover inside it gets cut off.
class LayoutsMenu extends React.Component {
  constructor(props) {
    super(props);
    this.state = { open: false, anchor: null, saving: false, name: '' };
  }

  toggle(open = !this.state.open) {
    if (open) {
      const rect = this.rootEl ? this.rootEl.getBoundingClientRect() : null;
      this.setState({
        open: true,
        saving: false,
        name: '',
        anchor: rect ? {
          top: rect.bottom + 6,
          right: Math.max(8, document.documentElement.clientWidth - rect.right),
        } : null,
      });
    } else {
      this.setState({ open: false, saving: false, name: '' });
    }
  }

  apply(layout) {
    this.props.onApplyLayout(layout);
    this.toggle(false);
  }

  save() {
    const name = this.state.name.trim();
    if (!name) return;
    this.props.onSaveLayout(name);
    this.toggle(false);
  }

  // Strip diagram: one bar per pane; hidden panes are faint
  // slivers. Labels keep the four bars readable.
  stripDiagram(layout) {
    return (
      <div className={styles.diagram}>
        {
          layout.visibles.map((visible, i) => (
            <div key={i}
                 title={PANE_NAMES[i]}
                 className={classes(styles.pane, !visible && styles.pane_hidden)}
                 style={visible ? { flexGrow: layout.weights[i] } : null}>
              <span className={styles.pane_label}>{['Nav', 'Viz', 'Code', 'AI'][i]}</span>
            </div>
          ))
        }
      </div>
    );
  }

  // Focus diagram: the actual 2x2 grid - left column Markdown over
  // Visualization, right column Code over Testcase.
  focusDiagram(layout) {
    const { cols, rows } = layout.focus;
    return (
      <div className={styles.diagram}>
        <div className={styles.focus_col} style={{ flexGrow: cols[0] }}>
          <div className={styles.pane} style={{ flexGrow: rows[0] }} title="Problem Markdown">
            <span className={styles.pane_label}>MD</span>
          </div>
          <div className={styles.pane} style={{ flexGrow: rows[1] }} title="Visualization">
            <span className={styles.pane_label}>Viz</span>
          </div>
        </div>
        <div className={styles.focus_col} style={{ flexGrow: cols[1] }}>
          <div className={styles.pane} style={{ flexGrow: 2 }} title="Code pad">
            <span className={styles.pane_label}>Code</span>
          </div>
          <div className={styles.pane} style={{ flexGrow: 1 }} title="Test cases">
            <span className={styles.pane_label}>Test</span>
          </div>
        </div>
      </div>
    );
  }

  diagram(layout) {
    return layout.mode === 'focus' ? this.focusDiagram(layout) : this.stripDiagram(layout);
  }

  card(layout, custom) {
    const { currentLayout } = this.props;
    const active = sameLayout(currentLayout, layout);
    return (
      <div key={(custom ? 'custom:' : 'builtin:') + layout.name}
           className={classes(styles.card, active && styles.card_active)}
           onClick={() => this.apply(layout)}>
        {this.diagram(layout)}
        <div className={styles.card_name}>
          <span>{layout.name}</span>
          {
            custom ? (
              <span className={styles.card_delete} title="Delete this layout"
                    onClick={e => { e.stopPropagation(); this.props.onDeleteLayout(layout.name); }}>
                ×
              </span>
            ) : null
          }
        </div>
      </div>
    );
  }

  render() {
    const { customLayouts } = this.props;
    const { open, anchor, saving, name } = this.state;
    const customs = customLayouts || [];
    return (
      <div className={styles.layouts_menu} ref={el => { this.rootEl = el; }}>
        <Button icon={faColumns} primary selected={open} onClick={() => this.toggle()}>Layouts</Button>
        {
          open ? (
            <React.Fragment>
              <div className={styles.overlay} onClick={() => this.toggle(false)}/>
              <div className={styles.popover}
                   style={anchor ? { top: anchor.top, right: anchor.right } : null}>
                <div className={styles.grid}>
                  {BUILTIN_LAYOUTS.map(layout => this.card(layout, false))}
                </div>
                {
                  customs.length ? (
                    <React.Fragment>
                      <div className={styles.section}>My layouts</div>
                      <div className={styles.grid}>
                        {customs.map(layout => this.card(layout, true))}
                      </div>
                    </React.Fragment>
                  ) : null
                }
                {
                  saving ? (
                    <div className={styles.save_row}>
                      <input className={styles.save_input} type="text" value={name} autoFocus
                             placeholder="Layout name"
                             onChange={e => this.setState({ name: e.target.value })}
                             onKeyDown={e => { if (e.key === 'Enter') this.save(); }}/>
                      <button className={styles.save_btn} disabled={!name.trim()} onClick={() => this.save()}>
                        Save
                      </button>
                    </div>
                  ) : (
                    <div className={styles.save_placeholder} onClick={() => this.setState({ saving: true })}>
                      + Save Current Layout
                    </div>
                  )
                }
              </div>
            </React.Fragment>
          ) : null
        }
      </div>
    );
  }
}

export default LayoutsMenu;
