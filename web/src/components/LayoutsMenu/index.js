import React from 'react';
import faColumns from '@fortawesome/fontawesome-free-solid/faColumns';
import { Button } from 'components';
import { classes } from 'common/util';
import { BUILTIN_LAYOUTS, PANE_NAMES, sameLayout } from 'common/layouts';
import styles from './LayoutsMenu.module.scss';

// The workspace layout picker (in the header, modelled on
// LeetCode's): preset cards with a mini pane diagram, the user's
// saved layouts, and Save Current Layout. A layout is just the
// workspace's {visibles, weights}; App owns the state, this
// component only renders the picker and reports choices.
class LayoutsMenu extends React.Component {
  constructor(props) {
    super(props);
    this.state = { open: false, saving: false, name: '' };
  }

  toggle(open = !this.state.open) {
    this.setState({ open, saving: false, name: '' });
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

  diagram(layout) {
    return (
      <div className={styles.diagram}>
        {
          layout.visibles.map((visible, i) => (
            <div key={i}
                 title={PANE_NAMES[i]}
                 className={classes(styles.pane, !visible && styles.pane_hidden)}
                 style={visible ? { flexGrow: layout.weights[i] } : null}/>
          ))
        }
      </div>
    );
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
    const { open, saving, name } = this.state;
    return (
      <div className={styles.layouts_menu}>
        <Button icon={faColumns} primary selected={open} onClick={() => this.toggle()}>Layouts</Button>
        {
          open ? (
            <React.Fragment>
              <div className={styles.overlay} onClick={() => this.toggle(false)}/>
              <div className={styles.popover}>
                <div className={styles.grid}>
                  {BUILTIN_LAYOUTS.map(layout => this.card(layout, false))}
                  {(customLayouts || []).map(layout => this.card(layout, true))}
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
