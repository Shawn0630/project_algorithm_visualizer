import React from 'react';
import faColumns from '@fortawesome/fontawesome-free-solid/faColumns';
import { Button } from 'components';
import { classes } from 'common/util';
import {
  BUILTIN_PRESETS, PANELS, panelTitle, presetTree, sameTree,
} from 'common/dock';
import styles from './LayoutsMenu.module.scss';

// The workspace layout picker for the docking system
// (common/dock). The workspace is a tree of panels the user can
// also rearrange directly by dragging panel tabs; this menu
// holds the built-in starter trees (Default / Focus / AI), the
// user's saved trees, and a Panels checklist for closing and
// reopening panels without dragging. The popover is positioned
// fixed, anchored to the button: the header clips overflow, so
// an absolutely positioned popover inside it gets cut off.
class LayoutsMenu extends React.Component {
  constructor(props) {
    super(props);
    this.state = { open: false, anchor: null, saving: false, name: '' };
  }

  toggle(open = !this.state.open) {
    if (open) {
      // The wrapper is display:contents (so the Button lays out
      // exactly like the other header buttons), so the anchor is
      // measured on the Button element itself.
      const buttonEl = this.rootEl ? this.rootEl.querySelector('[class*=Button_button]') || this.rootEl.firstElementChild : null;
      const rect = buttonEl ? buttonEl.getBoundingClientRect() : null;
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

  apply(entry) {
    this.props.onApplyLayout(entry);
    this.toggle(false);
  }

  save() {
    const name = this.state.name.trim();
    if (!name) return;
    this.props.onSaveLayout(name);
    this.toggle(false);
  }

  // A miniature of a dock tree: splits are flex boxes, leaves are
  // labeled cells (a tabbed leaf lists its panels).
  diagramNode(node) {
    if (node.kind === 'leaf') {
      return (
        <div className={styles.d_leaf} title={node.panels.map(panelTitle).join(' / ')}>
          <span className={styles.pane_label}>
            {node.panels.map(id => ({ navigator: 'Nav', doc: 'Desc', viz: 'Viz', code: 'Code', tests: 'Test', ai: 'AI' }[id] || id)).join('·')}
          </span>
        </div>
      );
    }
    return (
      <div className={node.dir === 'row' ? styles.d_row : styles.d_col}>
        {
          node.children.map((child, i) => (
            <div key={i} className={styles.d_cell} style={{ flexGrow: node.weights[i] }}>
              {this.diagramNode(child)}
            </div>
          ))
        }
      </div>
    );
  }

  card(entry, custom) {
    const { currentTree } = this.props;
    const active = sameTree(currentTree, entry.tree);
    return (
      <div key={(custom ? 'custom:' : 'builtin:') + entry.name}
           className={classes(styles.card, active && styles.card_active)}
           onClick={() => this.apply(entry)}>
        <div className={styles.diagram}>
          {this.diagramNode(entry.tree)}
        </div>
        <div className={styles.card_name}>
          <span>{entry.name}</span>
          {
            custom ? (
              <span className={styles.card_delete} title="Delete this layout"
                    onClick={e => { e.stopPropagation(); this.props.onDeleteLayout(entry.name); }}>
                ×
              </span>
            ) : null
          }
        </div>
      </div>
    );
  }

  render() {
    const { customLayouts, panelsPresent, onTogglePanel } = this.props;
    const { open, anchor, saving, name } = this.state;
    const customs = (customLayouts || []).map(entry => ({ name: entry.name, tree: entry.tree }));
    const builtins = BUILTIN_PRESETS.map(preset => ({ name: preset.name, tree: presetTree(preset.name) }));
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
                  {builtins.map(entry => this.card(entry, false))}
                </div>
                {
                  customs.length ? (
                    <React.Fragment>
                      <div className={styles.section}>My layouts</div>
                      <div className={styles.grid}>
                        {customs.map(entry => this.card(entry, true))}
                      </div>
                    </React.Fragment>
                  ) : null
                }
                <div className={styles.section}>Panels</div>
                <div className={styles.panel_list}>
                  {
                    PANELS.map(panel => {
                      const present = panelsPresent && panelsPresent.includes(panel.id);
                      return (
                        <label key={panel.id} className={styles.panel_row}>
                          <input type="checkbox" checked={!!present}
                                 onChange={() => onTogglePanel(panel.id)}/>
                          <span>{panel.title}</span>
                        </label>
                      );
                    })
                  }
                </div>
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
