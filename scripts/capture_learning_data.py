#!/usr/bin/env python3
"""
Angel Learning Data Capture Script
Exports structured data from all Angel tables for LLM training and learning.
"""

import sqlite3
import json
import os
from datetime import datetime, timezone

def connect_db(db_path):
    """Connect to SQLite database"""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn

def export_table_data(conn, table_name):
    """Export all data from a table with metadata"""
    cursor = conn.execute(f"SELECT * FROM {table_name}")
    rows = cursor.fetchall()
    
    if not rows:
        return []
    
    # Get column names
    columns = [description[0] for description in cursor.description]
    
    # Detect if table has 'id' column for ordering
    order_col = 'id' if 'id' in columns else (columns[0] if columns else None)
    if order_col:
        cursor = conn.execute(f"SELECT * FROM {table_name} ORDER BY {order_col} ASC")
        rows = cursor.fetchall()
    
    # Convert rows to list of dictionaries
    data = []
    for row in rows:
        row_dict = {}
        for i, col in enumerate(columns):
            value = row[i]
            # Convert sqlite types to Python types
            if isinstance(value, (int, float, str, type(None))):
                row_dict[col] = value
            else:
                # Handle JSON fields
                if col.endswith('_json') or col in ('candidate_json', 'filter_result_json', 
                                                   'summary_json', 'lessons_json', 'raw_json',
                                                   'guardrails_json', 'token_json', 'candidate_json',
                                                   'batch_json', 'execution_json', 'config_json',
                                                   'snapshot_json', 'payload_json', 'signals_json',
                                                   'evidence_json', 'route', 'status', 'payload_json',
                                                   'entry_json', 'exit_json'):
                    try:
                        row_dict[col] = json.loads(value) if value else None
                    except:
                        row_dict[col] = value
                else:
                    row_dict[col] = value
        
        # Add metadata
        row_dict['_export_timestamp'] = datetime.now(timezone.utc).isoformat()
        row_dict['_source_table'] = table_name
        data.append(row_dict)
    
    return data

def generate_summary(conn):
    """Generate metadata summary of the database"""
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [row[0] for row in cursor.fetchall()]
    
    summary = {
        'exported_at': datetime.now(timezone.utc).isoformat(),
        'database_path': '/root/Angel/angel.sqlite',
        'total_tables': len(tables),
        'tables': {},
        'learning_status': {
            'runs_count': 0,
            'lessons_count': 0,
            'has_active_lessons': False
        }
    }
    
    for table in tables:
        if table.startswith('sqlite_'):
            continue
            
        try:
            cursor = conn.execute(f"SELECT COUNT(*) as count FROM {table}")
            row = cursor.fetchone()
            summary['tables'][table] = {
                'row_count': row['count'],
                'exported': True
            }
            
            # Special handling for learning tables
            if table == 'learning_runs':
                summary['learning_status']['runs_count'] = row['count']
            elif table == 'learning_lessons':
                summary['learning_status']['lessons_count'] = row['count']
                if row['count'] > 0:
                    summary['learning_status']['has_active_lessons'] = True
        except Exception as e:
            summary['tables'][table] = {
                'row_count': 0,
                'exported': False,
                'error': str(e)
            }
    
    return summary

def export_learning_data(conn):
    """Export learning-specific data"""
    learning_data = {
        'learning_runs': export_table_data(conn, 'learning_runs'),
        'learning_lessons': export_table_data(conn, 'learning_lessons'),
        'decision_cache': export_table_data(conn, 'decision_cache'),
        'learning_summary': generate_summary(conn)
    }
    
    return learning_data

def export_all_data(conn):
    """Export data from all tables"""
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [row[0] for row in cursor.fetchall()]
    
    all_data = {}
    
    for table in tables:
        if table.startswith('sqlite_'):
            continue
            
        try:
            all_data[table] = export_table_data(conn, table)
        except Exception as e:
            print(f"Error exporting table {table}: {e}")
            all_data[table] = {
                'error': str(e),
                'exported': False
            }
    
    # Add learning data
    all_data['learning'] = export_learning_data(conn)
    
    return all_data

def save_exported_data(data, output_dir):
    """Save exported data to files"""
    files_written = []
    
    for table_name, table_data in data.items():
        if table_name == 'learning':
            # Save learning data as a single file
            filename = os.path.join(output_dir, 'learning_data.json')
            with open(filename, 'w') as f:
                json.dump(table_data, f, indent=2, default=str)
            files_written.append(os.path.basename(filename))
            continue
            
        if isinstance(table_data, dict) and 'error' in table_data:
            # Error case
            filename = os.path.join(output_dir, f"{table_name}_export_ERROR.json")
            with open(filename, 'w') as f:
                json.dump(table_data, f, indent=2, default=str)
            files_written.append(os.path.basename(filename))
        else:
            # Normal export
            filename = os.path.join(output_dir, f"{table_name}_export.json")
            with open(filename, 'w') as f:
                json.dump(table_data, f, indent=2, default=str)
            files_written.append(os.path.basename(filename))
    
    return files_written

def main():
    """Main function"""
    db_path = '/root/Angel/angel.sqlite'
    
    if not os.path.exists(db_path):
        print(f"Database not found: {db_path}")
        return
    
    print("Connecting to Angel database...")
    conn = connect_db(db_path)
    
    print("Exporting all table data...")
    all_data = export_all_data(conn)
    
    # Create output directory with timestamp
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    output_dir = f'/root/Angel/exports/learning_capture_{timestamp}'
    os.makedirs(output_dir, exist_ok=True)
    
    print(f"Saving exports to {output_dir}...")
    files_written = save_exported_data(all_data, output_dir)
    
    conn.close()
    
    print(f"\nExport complete!")
    print(f"Output directory: {output_dir}")
    print(f"Files written: {len(files_written)}")
    
    # Print summary stats
    summary = all_data.get('learning', {}).get('learning_summary', {})
    if summary:
        print(f"\nLearning Status:")
        print(f"  Learning runs: {summary.get('learning_status', {}).get('runs_count', 0)}")
        print(f"  Active lessons: {summary.get('learning_status', {}).get('lessons_count', 0)}")
        print(f"  Has active lessons: {summary.get('learning_status', {}).get('has_active_lessons', False)}")
        
        total_rows = sum(table_info.get('row_count', 0) for table_info in summary.get('tables', {}).values())
        print(f"  Total database rows: {total_rows:,}")
    
    print(f"\nExported tables: {list(all_data.keys())}")

if __name__ == '__main__':
    main()
